#!/bin/bash
# 在宿主机（GitHub Actions ubuntu-24.04 runner）上把 debs.txt 里全部 deb
# 下载、校验 sha256 并解包合并到 payload/ 目录，供 linglong.yaml 的 build
# 脚本在构建容器内直接拷贝使用。
#
# 为什么在宿主机做：玲珑 25.2.0 系列最新的 base（如 25.2.0.94）binary 模块
# 是精简 rootfs，没有 apt-get，也没有 binutils/file/patchelf/zstd，容器内
# 无法解包 deb。宿主机 runner 上一条 apt 就能装齐工具，解包结果随工程目录
# 挂载进容器（/project/payload），容器内只剩纯拷贝 + sed。
#
# 用法: ./prepare_payload.sh debs.txt payload/
set -euo pipefail

deb_list="$1"
out="$2"

command -v curl >/dev/null || { echo "ERROR: curl missing"; exit 1; }
command -v dpkg-deb >/dev/null || { echo "ERROR: dpkg-deb missing"; exit 1; }
command -v patchelf >/dev/null || { echo "ERROR: patchelf missing (apt install patchelf)"; exit 1; }
command -v readelf >/dev/null || { echo "ERROR: readelf missing (apt install binutils)"; exit 1; }
command -v file >/dev/null || { echo "ERROR: file missing"; exit 1; }

rm -rf "$out"
mkdir -p "$out"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

total=0
while read -r url sha; do
  [ -z "${url:-}" ] && continue
  case "$url" in \#*) continue ;; esac
  # 防脏数据：只接受 http(s) URL 行（曾出现过文件被编辑器/传输工具
  # 混入 "AIGC:" 等杂散行，导致 curl 报 "Port number was not a decimal number"）
  case "$url" in
    https://*|http://*) ;;
    *) echo "SKIP invalid line (not a URL): $url" >&2; continue ;;
  esac
  if [ -z "${sha:-}" ]; then
    echo "ERROR: line missing sha256 digest: $url" >&2
    exit 1
  fi
  total=$((total + 1))
  deb="$work/$(basename "$url")"
  echo "[$total] $(basename "$url")"
  curl -fsSL --retry 3 --connect-timeout 30 -o "$deb" "$url"
  echo "$sha  $deb" | sha256sum -c --quiet

  # 解包合并（dpkg-deb 原生支持 data.tar.zst / xz / gz）
  dpkg-deb -x "$deb" "$out"
  echo "Package: $(dpkg-deb -f "$deb" Package)" >> "$out/packages.list"
done < "$deb_list"
echo "extracted $total debs into $out"
# 守卫：解包数量必须等于 debs.txt 中的 URL 行数（下载失败/文件损坏时在这里
# 失败，宁可失败也不要打出一个缺依赖的包）。清单条目数改动后无需改这里
expected=$(grep -cE '^[[:space:]]*https?://' "$deb_list" || true)
if [ "$total" -ne "$expected" ]; then
  echo "ERROR: debs.txt has $expected debs but only extracted $total — check debs.txt for corrupted lines" >&2
  exit 1
fi

# ---- 以下清理/修补逻辑与官方 install_dep 保持一致 ----

# 清理不需要进 layer 的目录（桌面入口由 linglong.yaml 自己生成）
rm -rf "$out/usr/share/applications" 2>/dev/null || true
rm -rf "$out/usr/share/systemd" 2>/dev/null || true
rm -rf "$out/usr/lib/systemd" 2>/dev/null || true
rm -rf "$out/lib/systemd" 2>/dev/null || true

# ---- UAB 体积裁剪（共 ~62MB，均不影响应用运行） ----
# 设 TRIM_UAB=0 可整体关闭裁剪
if [ "${TRIM_UAB:-1}" = "1" ]; then
  echo "trimming payload to shrink uab..."
  # 1) 运行时用不到的杂项：tex-gyre 字体源文件(.sfd)、软件文档、man 页、
  #    lintian 覆盖文件、bug 报告脚本、zsh 补全（约 25MB）
  rm -rf "$out/usr/share/texmf" "$out/usr/share/doc" "$out/usr/share/man" \
         "$out/usr/share/lintian" "$out/usr/share/bug" "$out/usr/share/zsh"
  # 2) 拼写检查词典（约 10MB）：hunspell/aspell/ispell。enchant 的后端是
  #    dlopen 动态加载的插件（usr/lib/x86_64-linux-gnu/enchant-2/*.so），
  #    缺词典只是"拼写检查不可用"，不会导致任何库加载失败
  rm -rf "$out/usr/share/hunspell" "$out/usr/share/aspell" "$out/usr/share/ispell" \
         "$out/usr/lib/aspell" "$out/usr/lib/ispell"
  # 3) 翻译文件只留 zh_CN/zh_TW/en_US（约省 4.3MB，中文阅读应用够用）
  #    注意 grep -v 无匹配时返回 1，set -o pipefail 下必须 || true 兜底
  find "$out/usr/share/locale" -maxdepth 1 -mindepth 1 -type d \
    | grep -vE '/(zh_CN|zh_TW|zh_SG|en_US)$' | xargs -r rm -rf || true
  # 4) 基础拉丁字体：freefont/croscore/liberation（约 27MB）。deepin base
  #    自带 Noto/思源系基础字体，这些是 deb 依赖解析时被拖进来的冗余字体
  rm -rf "$out/usr/share/fonts/truetype/freefont" "$out/usr/share/fonts/opentype/freefont" \
         "$out/usr/share/fonts/truetype/croscore" "$out/usr/share/fonts/truetype/liberation"
  # 5) Noto CJK 字体（约 90MB）：默认保留以保证中文渲染兜底。
  #    若确认 base（org.deepin.base/25.2.0）已含 CJK 字体，可在 workflow 中
  #    设 KEEP_CJK_FONTS=0 进一步缩减 90MB（渲染时回退到 base 字体）
  if [ "${KEEP_CJK_FONTS:-1}" != "1" ]; then
    rm -rf "$out/usr/share/fonts/opentype/noto"
    echo "  (KEEP_CJK_FONTS=0) removed Noto CJK fonts (~90MB)"
  fi
  du -sh "$out"
fi


# 修复指向 /lib 的绝对软链接（部分 dev 包会创建 so 文件的绝对链接指向 /lib）
find "$out" -type l | while IFS= read -r file; do
  linkTarget=$(readlink "$file")
  if echo "$linkTarget" | grep -q '^/lib' && ! [ -f "$linkTarget" ]; then
    newTarget="$out$linkTarget"
    ln -sf "$newTarget" "$file"
    echo "    FIX LINK $file: $linkTarget => $newTarget"
  fi
done

# 修复动态库的 RUNPATH（与 install_dep 相同规则：绝对路径中含
# usr/lib/runtime/lib 或 usr/runtime 子串时做替换，其余保持不变）
find "$out" -type f | while IFS= read -r file; do
  fileinfo=$(file -b "$file")
  case "$fileinfo" in
    *shared\ object*) ;;
    *) continue ;;
  esac
  # 大多数库没有 RUNPATH，grep 无匹配会返回 1；必须 || true，
  # 否则 set -euo pipefail 下赋值失败会直接终止脚本
  runpath=$(readelf -d "$file" 2>/dev/null | grep RUNPATH | awk '{print $NF}' || true)
  [ -n "$runpath" ] || continue
  case "$runpath" in
    \[/*) ;;
    *) continue ;;
  esac
  runpath=${runpath#[}
  runpath=${runpath%]}
  newRunpath=${runpath//usr\/lib\/runtime\/lib}
  newRunpath=${newRunpath//usr\/runtime}
  if [ "$newRunpath" != "$runpath" ]; then
    patchelf --set-rpath "$newRunpath" "$file"
    echo "    FIX RUNPATH $file: $runpath => $newRunpath"
  fi
done

# 修复悬空的相对软链接（链接目标先去掉 payload 前缀、再加 usr 前缀查找）
find "$out" -type l | while IFS= read -r file; do
  linkTarget=$(readlink -m "$file")
  if [ ! -e "$linkTarget" ]; then
    linkTarget="${linkTarget#"$out"}"
    if [ -e "$linkTarget" ]; then
      ln -sf "$linkTarget" "$file"
      echo "    FIX LINK $file => $linkTarget"
      continue
    fi
    if [ -e "/usr$linkTarget" ]; then
      ln -sf "/usr$linkTarget" "$file"
      echo "    FIX LINK $file => /usr$linkTarget"
    fi
  fi
done

echo "payload summary:"
du -sh "$out"
ls "$out"
