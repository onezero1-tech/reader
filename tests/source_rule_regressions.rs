use reader_rust::model::book_source::book_source_from_value;
use reader_rust::parser::{html, rule_engine::RuleEngine};
use serde_json::json;

#[test]
fn modern_source_scripts_and_request_options_survive_round_trips() {
    let search = "@js:\nvar options = {method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded','Referer':baseUrl},body:'searchkey='+java.encodeURI(key)}; baseUrl+'/search/,'+JSON.stringify(options)";
    let login = "function login(){source.putLoginInfo(JSON.stringify({name:result.name,password:result.password}));}";
    let explore = r#"/list,{"method":"POST","body":{"page":1,"size":20}}"#;
    let mut value = json!({
        "bookSourceUrl": "https://example.test", "bookSourceName": "Modern",
        "searchUrl": search, "loginUrl": login, "exploreUrl": explore
    });
    for _ in 0..3 {
        let source = book_source_from_value(value).unwrap();
        assert_eq!(source.search_url.as_deref(), Some(search));
        assert_eq!(source.login_url.as_deref(), Some(login));
        assert_eq!(source.explore_url.as_deref(), Some(explore));
        value = serde_json::to_value(source).unwrap();
    }
}

#[test]
fn legacy_url_migration_preserves_explicit_modern_overrides() {
    let source = book_source_from_value(json!({
        "bookSourceUrl":"https://example.test", "bookSourceName":"Mixed",
        "ruleSearchUrl":"/old?q=searchKey&page={1,2,3}",
        "searchUrl":"@js:JSON.stringify({a:1,b:2})",
        "ruleFindUrl":"/list?page={1,2,3}&q=searchKey"
    })).unwrap();
    assert_eq!(source.search_url.as_deref(), Some("@js:JSON.stringify({a:1,b:2})"));
    assert_eq!(source.explore_url.as_deref(), Some("/list?page=<1,2,3>&q={{key}}"));
}

#[test]
fn search_redirect_to_matching_detail_uses_book_info_rules() {
    let source = book_source_from_value(json!({
        "bookSourceUrl":"https://example.test", "bookSourceName":"Redirect",
        "bookUrlPattern":"https://example\\.test/books/\\d+/",
        "ruleSearch":{"bookList":".result", "name":"a@text", "bookUrl":"a@href"},
        "ruleBookInfo":{"name":"meta[property=og:novel:book_name]@content", "author":"#author@text"}
    })).unwrap();
    let body = r#"<meta property="og:novel:book_name" content="示例书"><div id="author">作者甲</div><div class="result"><a href="/ad">推荐广告</a></div>"#;
    let engine = RuleEngine::new().unwrap();
    let books = engine.search_books(&source, body, "https://example.test/books/42/");
    assert_eq!(books.len(), 1);
    assert_eq!(books[0].name, "示例书");
    assert_eq!(books[0].author, "作者甲");
    assert_eq!(books[0].book_url, "https://example.test/books/42/");
    let regular = engine.search_books(&source, body, "https://example.test/search");
    assert_eq!(regular[0].name, "推荐广告");
}

#[test]
fn chapter_selectors_traverse_every_step_and_keep_chapter_order() {
    let source = book_source_from_value(json!({
        "bookSourceUrl":"https://example.test", "bookSourceName":"Chained",
        "ruleToc":{"chapterList":"#chapters@dd@a", "chapterName":"text", "chapterUrl":"href"}
    })).unwrap();
    let body = "<div id='chapters'><dl><dd><a href='/1'>第一章</a></dd><dd><a href='/2'>第二章</a><a href='/3'>第三章</a></dd></dl></div>";
    let (chapters, _) = RuleEngine::new().unwrap().chapter_list(&source, body, "https://example.test/book", None);
    assert_eq!(chapters.iter().map(|c| c.title.as_str()).collect::<Vec<_>>(), ["第一章", "第二章", "第三章"]);
    assert_eq!(chapters.iter().map(|c| c.url.as_str()).collect::<Vec<_>>(), ["https://example.test/1", "https://example.test/2", "https://example.test/3"]);
    let doc = html::parse_document(body);
    let selected = html::select_list(&doc, "#missing@dd@a||#chapters@dd.1@a.0");
    assert_eq!(selected.len(), 1);
    assert_eq!(selected[0].value().attr("href"), Some("/2"));
    assert_eq!(html::select_text_list(&doc, "#chapters@dd@a@href"), ["/1", "/2", "/3"]);
}

#[test]
fn scripts_can_return_arrays_of_json_encoded_books_and_chapters() {
    let source = book_source_from_value(json!({
        "bookSourceUrl":"https://example.test", "bookSourceName":"JSON rows",
        "ruleSearch":{"bookList":"@js:[JSON.stringify({name:'示例书',url:'data:text/plain;base64,Ym9vaz0x'})]", "name":"$.name", "bookUrl":"$.url"},
        "ruleToc":{"chapterList":"@js:[JSON.stringify({name:'第一章',url:'/1'}),JSON.stringify({name:'第二章',url:'/2'})]", "chapterName":"$.name", "chapterUrl":"$.url"}
    })).unwrap();
    let engine = RuleEngine::new().unwrap();
    let books = engine.search_books(&source, "", "https://example.test");
    assert_eq!(books.len(), 1);
    assert_eq!(books[0].name, "示例书");
    let (chapters, _) = engine.chapter_list(&source, "", "https://example.test", None);
    assert_eq!(chapters.len(), 2);
    assert_eq!(chapters[1].url, "https://example.test/2");
}

#[test]
fn book_metadata_templates_can_embed_selection_rules() {
    let source = book_source_from_value(json!({
        "bookSourceUrl":"https://example.test", "bookSourceName":"Embedded selectors",
        "ruleBookInfo":{"name":"h1@text", "kind":"{{@@.category@text}},{{@@.status@text}}"}
    })).unwrap();
    let book = RuleEngine::new().unwrap().book_info(&source, "<h1>示例书</h1><span class='category'>玄幻</span><span class='status'>完结</span>", "https://example.test", "https://example.test/book");
    assert_eq!(book.kind.as_deref(), Some("玄幻,完结"));
}

#[test]
fn book_info_initialization_runs_before_field_selection() {
    let source = book_source_from_value(json!({
        "bookSourceUrl":"https://example.test", "bookSourceName":"Initialized info",
        "ruleBookInfo":{"init":"@js:JSON.stringify({book_name:'初始化书名',author:'作者甲'})", "name":"$.book_name", "author":"$.author"}
    })).unwrap();
    let book = RuleEngine::new().unwrap().book_info(&source, "book_id=123", "data:text/plain,book_id=123", "data:text/plain,book_id=123");
    assert_eq!(book.name, "初始化书名");
    assert_eq!(book.author, "作者甲");
}

/// 该源的两个关键语法:
/// 1. bookList 用省略 `$` 前缀的 JSON 点路径（`data.books`）
/// 2. 字段尾部的 `@put:{"bid":"$.id"}`（legado putPattern 任意位置分离），
///    put 的值跨阶段对 `java.get()` 可见。
#[test]
fn bare_json_paths_and_trailing_put_rules() {
    let source = book_source_from_value(json!({
        "bookSourceUrl":"https://bare-json.test", "bookSourceName":"该源风格",
        "ruleSearch":{"bookList":"data.books", "name":"original_title", "bookUrl":"@js:'https://api.test/detail?id='+'{{$.id}}'"},
        "ruleBookInfo":{"init":"data.book", "name":"title@put:{\"bid\":\"$.id\"}"}
    })).unwrap();
    let engine = RuleEngine::new().unwrap();
    let search_body = r#"{"data":{"books":[{"id":"7237498","original_title":"测试书"}]}}"#;
    let books = engine.search_books(&source, search_body, "https://bare-json.test/search");
    assert_eq!(books.len(), 1, "省略 $ 前缀的 bookList 应能解析出列表");
    assert_eq!(books[0].name, "测试书");

    let detail_body = r#"{"data":{"book":{"id":"7237498","title":"测试书全名"}}}"#;
    let book = engine.book_info(&source, detail_body, "https://api.test/detail?id=7237498", "https://api.test/detail?id=7237498");
    assert_eq!(book.name, "测试书全名", "尾部 @put 应被分离, name 仍取 title");
    // @put 存的 bid 应进入 java.get 可见的变量存储（详情→搜索字段跨阶段读取）
    let bid = reader_rust::parser::js::with_source(&source, || {
        reader_rust::parser::js::eval_js("java.get('bid')", "", "https://bare-json.test")
    }).unwrap();
    assert_eq!(bid, "7237498");
    // 搜索字段规则读回 put 的 bid
    assert_eq!(books[0].book_url, "https://api.test/detail?id=7237498");
}

/// 书源 header 里的 Unicode 连字符变体（如 `User‑Agent` U+2011）应被
/// 规范化为 ASCII '-'，非法头名被跳过而不是让请求构造失败。
#[test]
fn header_names_with_unicode_hyphens_are_normalized() {
    use reader_rust::crawler::url_analyzer::source_header_spec;
    let source = book_source_from_value(json!({
        "bookSourceUrl":"https://hyphen.test", "bookSourceName":"连字符",
        "header":"{\"User‑Agent\":\"Mozilla/5.0\",\"X‑Custom\":\"abc\",\"Bad Header\":\"x\"}"
    })).unwrap();
    let spec = source_header_spec(&source).unwrap();
    let names: Vec<&str> = spec.headers.iter().map(|(name, _)| name.as_str()).collect();
    assert!(names.contains(&"User-Agent"), "U+2011 应归一为 '-': {names:?}");
    assert!(names.contains(&"X-Custom"), "U+2011 应归一为 '-': {names:?}");
    assert!(!names.iter().any(|n| n.contains(' ')), "含空格的非法头名应被跳过: {names:?}");
}

/// 正文规则抛出的**书源业务提示**（如书源的 VIP 限制）必须变成可读错误，
/// 而不是静默的空正文 —— 否则界面上"点了没反应"，用户不知道发生了什么。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn content_rule_business_error_is_reported_to_the_user() {
    use axum::{routing::get, Router};
    use reader_rust::{
        crawler::http_client::HttpClient,
        service::book_service::BookService,
        storage::cache::file_cache::FileCache,
    };

    let app = Router::new().route("/chapter/1", get(|| async {
        ([("content-type", "application/json")], json!({"code": 403, "msg": "vip only"}).to_string())
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    let source = book_source_from_value(json!({
        "bookSourceName": "VIP提示测试", "bookSourceUrl": "custom://vip-test",
        "jsLib": "function J(r){ if(typeof r==='string'){ try{return JSON.parse(r);}catch(e){ return {}; } } return r||{}; }",
        "ruleContent": { "content":
            "<js>var r=J(result); if(r.code==403){ throw '本书源为VIP专属内容，开通VIP后可阅读'; } r.msg;</js>" }
    })).unwrap();

    let root = std::env::temp_dir().join(format!("vip-error-{}", uuid::Uuid::new_v4()));
    let service = BookService::new(
        HttpClient::new(5, None).unwrap(),
        RuleEngine::new().unwrap(),
        FileCache::new(root.join("cache")),
        root.to_str().unwrap(),
    );

    let chapter_url = format!("{base}/chapter/1");
    let error = service
        .get_content("default", "https://mock/book/1", &source, &chapter_url)
        .await
        .expect_err("VIP 限制应报错而不是返回空正文");
    let message = format!("{error:?}");
    assert!(message.contains("VIP专属内容"), "应透出书源自己的提示: {message}");
    assert!(!message.contains("[正文 JS]"), "不应把内部日志前缀暴露给用户: {message}");
    assert!(!message.contains("正文解析为空"), "不应退化成泛化提示: {message}");
    server.abort();
}

/// 复现「Cin漫画」一类接口源: `ruleSearch.bookUrl` 写单花括号 JSONPath 模板
/// `https://cin.onl/v/{$.id}`。
///
/// 此前模板原样留在 bookUrl 里, 连带三处故障:
///   1. 目录抓取请求字面量 `https://cin.onl/v/{$.id}` → 0 章 →「目录为空」;
///   2. 正文规则 `result.match(...)[0]` 在空页面上抛 cannot read property of null;
///   3. 探索/搜索每本书 bookUrl 相同, 前端按 bookUrl 去重后整页只剩一本。
#[test]
fn single_brace_jsonpath_template_in_book_url_is_expanded_per_item() {
    let source = book_source_from_value(json!({
        "bookSourceUrl":"https://cin.onl", "bookSourceName":"Cin漫画", "bookSourceType":2,
        "ruleSearch":{
            "bookList":"$.result",
            "name":"$.title.pretty",
            "bookUrl":"https://cin.onl/v/{$.id}",
            "coverUrl":"$.cover.t"
        },
        "ruleExplore": {}
    })).unwrap();
    let body = json!({"result":[
        {"id":"abc123","title":{"pretty":"作品一"},"cover":{"t":"https://cin.onl/covers/a.webp"}},
        {"id":"def456","title":{"pretty":"作品二"},"cover":{"t":"https://cin.onl/covers/b.webp"}}
    ]}).to_string();
    let engine = RuleEngine::new().unwrap();

    let books = engine.search_books(&source, &body, "https://cin.onl");
    assert_eq!(books.len(), 2, "两本书都要解析出来");
    assert_eq!(books[0].book_url, "https://cin.onl/v/abc123");
    assert_eq!(books[1].book_url, "https://cin.onl/v/def456");
    // 模板展开后每本书地址互不相同, 前端按 bookUrl 去重才不会只剩一本
    assert_ne!(books[0].book_url, books[1].book_url);

    // ruleExplore 整个为空时回退 ruleSearch, 探索页同样要展开模板
    let explore = engine.explore_books(&source, &body, "https://cin.onl");
    assert_eq!(explore.len(), 2);
    assert_eq!(explore[0].book_url, "https://cin.onl/v/abc123");
    assert_eq!(explore[1].book_url, "https://cin.onl/v/def456");
}

/// 模板取不到字段时保持原样(不吞数据); 双花括号 `{{...}}` 模板不能被误伤。
#[test]
fn single_brace_template_fallbacks_and_double_brace_untouched() {
    let item = json!({"name":"示例书", "id":42});
    let source = book_source_from_value(json!({
        "bookSourceUrl":"https://example.test", "bookSourceName":"T",
        "ruleSearch":{
            "bookList":"$.list",
            "name":"$.name",
            "bookUrl":"https://example.test/b/{$.id}/name={{$.name}}/missing={$Missing}"
        }
    })).unwrap();
    let body = json!({"list":[item.clone(), {"name":"无ID的书"}]}).to_string();
    let books = RuleEngine::new().unwrap().search_books(&source, &body, "https://example.test");
    assert_eq!(books.len(), 2);
    // 数字字段同样展开; 双花括号 `{{$.name}}` 走原有语义不受影响
    assert_eq!(books[0].book_url, "https://example.test/b/42/name=示例书/missing={$Missing}");
    // 字段缺失时保留原样, 不拼出错误 URL
    assert_eq!(books[1].book_url, "https://example.test/b/{$.id}/name=无ID的书/missing={$Missing}");
}
