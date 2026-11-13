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
# 守卫：依赖清单应为 71 个 deb（webkit2gtk + 托盘 + 字体）。少下载会导致
# layer 缺库，宁可在这里失败也不要打出一个缺依赖的包
if [ "$total" -ne 71 ]; then
  echo "ERROR: expected 65 debs but only extracted $total — check debs.txt for corrupted lines" >&2
  exit 1
fi

# ---- 以下清理/修补逻辑与官方 install_dep 保持一致 ----

# 清理不需要进 layer 的目录（桌面入口由 linglong.yaml 自己生成）
rm -rf "$out/usr/share/applications" 2>/dev/null || true
rm -rf "$out/usr/share/systemd" 2>/dev/null || true
rm -rf "$out/usr/lib/systemd" 2>/dev/null || true
rm -rf "$out/lib/systemd" 2>/dev/null || true

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
