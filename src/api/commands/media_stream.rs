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

/// 前端媒体错误的回传口: `<video>` / hls.js 报错时把细节写进后端日志。
///
/// 为什么需要它: 发布版(玲珑包)里 WebView 的 console 没有出口, `ll-cli run`
/// 的 stdout 看不到任何前端日志。播放失败时后端侧只能看到代理 200/流式响应,
/// 无法区分「缺解码器」「渲染 sink 失败」「地址过期」。把 MediaError 的
/// code/message 汇报进 tracing, 一次运行日志即可自证病因。
#[tauri::command]
pub fn report_media_error(player: String, code: Option<i32>, message: String, src: String) {
    // 只留 host+path: 签名 query 与 #.mp4 识别片段不该进日志。
    let bare = src.split(['?', '#']).next().unwrap_or(&src);
    let message: String = message.chars().take(300).collect();
    tracing::warn!(
        player = %player,
        media_error_code = ?code,
        media_error = %message,
        src = %bare,
        "frontend media playback error"
    );
}
