//! 回环媒体流服务 —— mp4 直链专用(`<video>` 走真实 HTTP, 不再走 reader:// 协议)。
//!
//! ## 为什么需要它
//!
//! `<video>` 播 mp4 直链时, WebKitGTK 的媒体栈(GStreamer)对 `reader://`
//! 自定义协议响应的 Range 语义处理不可靠。实测症状(玲珑包 + org.deepin.runtime
//! .gtk4, webkit 2.50.4): 媒体栈发出嗅探请求 `bytes=0-1445`, 代理以 206 +
//! Content-Range 正确回传 1446 字节之后, 管线**静默放弃** —— 不发任何后续
//! Range 请求、`<video>` 不再推进, 表现就是"永远转圈"。解码器(libav)、
//! 输出 sink(gtksink/gtkglsink/glimagesink)在容器里全部齐备, 代理侧响应
//! 头也完整(wry 0.57 已用 finish_with_response 透传 206/头), 问题出在
//! WebKit 内部把协议响应映射给 GStreamer 源的那一环, 应用侧无法修复。
//!
//! 解法是绕开它: 在 `127.0.0.1:{随机端口}` 上起一个**仅媒体**的 axum 服务,
//! 处理逻辑原样复用 [`crate::api::protocol::media_route`](Range/206/分块
//! 截断/播放列表改写全一致)。`<video>` 拿到 `http://127.0.0.1:...` 的地址,
//! 由内核 socket 承载标准 HTTP —— WebKit 的 soup 源对 Range/206 的支持
//! 与普通网站完全相同。HLS 不受影响(hls.js 用 fetch 拉整个响应, 协议路径
//! 一直正常), 暂不改道。
//!
//! ## 安全
//!
//! - 只监听回环地址, 局域网不可达;
//! - 请求路径必须携带进程启动时生成的 128-bit 随机 token(占基址尾段), 本机其它
//!   进程无法猜出地址 —— base URL 只经 IPC 交给前端, 不落盘、不进日志;
//! - 媒体地址本身带签名时效, 响应一律 no-store。

use crate::api::AppState;
use axum::extract::{Path, RawQuery, State};
use axum::http::header::{ACCESS_CONTROL_ALLOW_ORIGIN, RANGE};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use rand::RngCore;
use std::sync::OnceLock;

/// 服务基址(`http://127.0.0.1:{port}/{token}`, token 占路径尾段), 启动成功后
/// 写入; 前端经 `media_stream_base` 命令读取后拼 `/media?path=...` 使用。
static BASE_URL: OnceLock<String> = OnceLock::new();

/// 访问 token(基址的路径尾段)。与 BASE_URL 同时写入; 不匹配一律 404。
static TOKEN: OnceLock<String> = OnceLock::new();

/// 回环媒体服务基址; 未启动(或启动失败)时返回 None, 前端回退协议地址。
pub fn base_url() -> Option<&'static str> {
    BASE_URL.get().map(String::as_str)
}

/// 启动回环媒体服务。失败只记日志不中断启动 —— 协议路径仍是兜底。
pub async fn start(state: AppState) {
    let Ok(listener) = tokio::net::TcpListener::bind("127.0.0.1:0").await else {
        tracing::warn!("media loopback server: bind 127.0.0.1:0 failed, mp4 stays on reader:// scheme");
        return;
    };
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);

    let mut bytes = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();

    let _ = TOKEN.set(token.clone());
    let _ = BASE_URL.set(format!("http://127.0.0.1:{port}/{token}"));

    let app = Router::new()
        .route("/:token/media", get(media))
        .with_state(state);
    tokio::spawn(async move {
        if let Err(err) = axum::serve(listener, app).await {
            tracing::error!("media loopback server stopped: {err}");
        }
    });
    tracing::info!(port, "media loopback server ready (mp4 direct links)");
}

/// `GET /{token}/media?path=...&source=...` —— 查询串原样转交
/// [`crate::api::protocol::media_route`]。
async fn media(
    State(state): State<AppState>,
    Path(path_token): Path<String>,
    RawQuery(raw_query): RawQuery,
    headers: HeaderMap,
) -> Response {
    if !token_matches(&path_token) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let query = raw_query.unwrap_or_default();
    let range = headers.get(RANGE).and_then(|v| v.to_str().ok());
    // slice_unranged = true: 本路径只有 <video> 原生媒体栈, 其首个媒体请求
    // 不带 Range —— 后端据此给上游强制 bytes=0- 并按块回传, 直链不再整读
    // (整读既慢又容易在长传输中被 CDN 掐断)。详见 book_service 注释。
    let proxied =
        crate::api::protocol::media_route(&state, &query, range, true).await;
    // 允许任意来源跨域读取: 服务有 token 把门, 且这给未来 HLS 整体迁移到
    // 回环 HTTP(hls.js 的 fetch 需要 CORS)留好路。
    let (parts, body) = proxied.into_parts();
    let mut builder = axum::http::Response::builder().status(parts.status);
    builder = builder.header(ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
    for (name, value) in parts.headers.iter() {
        builder = builder.header(name, value);
    }
    match builder.body(axum::body::Body::from(body)) {
        Ok(resp) => resp.into_response(),
        // 头部非法(上游返回了无法编码的头)才走到这里; 与门禁一样不给细节。
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

/// 门禁判定(纯函数便于单测): 路径段 token 必须与进程 token 完全一致;
/// TOKEN 未写入(服务未启动)时一律拒绝。校验失败不区分 403/404, 不给探测者信息。
fn token_matches(path_token: &str) -> bool {
    TOKEN.get().map(|t| t == path_token).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 门禁: token 一致才放行; 缺失/错误一律拒绝。
    /// (代理转发路径的 Range/206 行为已有 protocol 侧完整测试, 这里只验门禁;
    /// OnceLock 是进程级单例, 所有用例共用同一个 token 值即可。)
    #[test]
    fn token_gate_rejects_missing_wrong_or_uninitialized() {
        let _ = TOKEN.set("deadbeef01".to_string());
        assert!(token_matches("deadbeef01"));
        assert!(!token_matches("wrong"));
        assert!(!token_matches(""));
        assert!(!token_matches("deadbeef010"));
    }
}
