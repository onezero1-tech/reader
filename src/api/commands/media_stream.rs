/// 回环媒体服务的 IPC 查询命令。
///
/// 前端拿到基址后把 mp4 直链(`<video>` 的 src)改写到 `127.0.0.1` 的真实
/// HTTP 服务上 —— WebKitGTK 的媒体栈对 `reader://` 协议响应的 Range 语义
/// 处理不可靠, 详见 `crate::api::media_stream` 模块注释。
///
/// 服务未启动(启动失败/非桌面环境)时返回 null, 前端原样使用协议地址。

/// 回环媒体服务基址(含端口, 不含 token —— token 由前端拼进 query)。
/// 实际形态: `http://127.0.0.1:{port}`。
#[tauri::command]
pub fn media_stream_base() -> Option<String> {
    crate::api::media_stream::base_url().map(str::to_owned)
}
