use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::sync::{atomic::{AtomicBool, AtomicU64, Ordering}, Arc, Mutex};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
#[cfg(target_os = "windows")]
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
#[cfg(target_os = "windows")]
use windows_sys::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
#[cfg(target_os = "windows")]
use windows_sys::Win32::UI::WindowsAndMessaging::{CallNextHookEx, KBDLLHOOKSTRUCT, SetWindowsHookExW};

struct TrayHandle(#[allow(dead_code)] tauri::tray::TrayIcon<tauri::Wry>);
struct SearchCursor { token: String, api_key: String, client_version: String, visitor_data: String }
struct SearchState(Arc<Mutex<HashMap<String, SearchCursor>>>);
static NEXT_CURSOR: AtomicU64 = AtomicU64::new(1);
static INPUT_LOCKED: AtomicBool = AtomicBool::new(false);

#[cfg(target_os = "windows")]
unsafe extern "system" fn input_lock_hook(code: i32, message: usize, data: isize) -> isize {
  if code == 0 && INPUT_LOCKED.load(Ordering::Relaxed) {
    let key = (*(data as *const KBDLLHOOKSTRUCT)).vkCode;
    if key != 0x10 && !(key == 0x58 && GetAsyncKeyState(0x10) < 0) { return 1; }
  }
  CallNextHookEx(std::ptr::null_mut(), code, message, data)
}

#[cfg(target_os = "windows")]
fn install_input_lock_hook() -> Result<(), String> {
  let hook = unsafe { SetWindowsHookExW(13, Some(input_lock_hook), GetModuleHandleW(std::ptr::null()), 0) };
  if hook.is_null() { return Err("Could not install the Windows-key input lock".into()); }
  Ok(())
}

#[cfg(not(target_os = "windows"))]
fn install_input_lock_hook() -> Result<(), String> { Ok(()) }

#[derive(Serialize)]
struct SearchResult { id: String, title: String, channel: String, channel_id: String, duration: String, thumbnail: String }
#[derive(Serialize)]
struct SearchPage { results: Vec<SearchResult>, cursor: Option<String> }
#[derive(Clone, Deserialize, Serialize)]
struct Subscription { channel: String, #[serde(default)] channel_id: String, #[serde(default)] avatar: String }
#[derive(Clone, Deserialize, Serialize)]
struct BlockedItem { kind: String, value: String, #[serde(default)] label: String, #[serde(default)] thumbnail: String }

fn subscriptions_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
  let directory = app.path().app_data_dir().map_err(|error| error.to_string())?;
  fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
  let path = directory.join("subscriptions.json");
  let legacy = directory.parent().map(|parent| parent.join("land.moreno.youtube-tauri").join("subscriptions.json"));
  if !path.exists() { if let Some(legacy) = legacy { if legacy.exists() { fs::copy(legacy, &path).map_err(|error| error.to_string())?; } } }
  Ok(path)
}

fn read_subscriptions(app: &tauri::AppHandle) -> Result<Vec<Subscription>, String> {
  let path = subscriptions_path(app)?;
  if !path.exists() { return Ok(Vec::new()); }
  serde_json::from_str(&fs::read_to_string(path).map_err(|error| error.to_string())?).map_err(|error| error.to_string())
}

fn blocks_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
  let directory = app.path().app_data_dir().map_err(|error| error.to_string())?;
  fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
  Ok(directory.join("blocks.json"))
}

fn read_blocks(app: &tauri::AppHandle) -> Result<Vec<BlockedItem>, String> {
  let path = blocks_path(app)?;
  if !path.exists() { return Ok(Vec::new()); }
  serde_json::from_str(&fs::read_to_string(path).map_err(|error| error.to_string())?).map_err(|error| error.to_string())
}

fn dedupe_blocks(blocks: &mut Vec<BlockedItem>) {
  let mut seen = HashSet::new();
  blocks.retain(|item| seen.insert(format!("{}:{}", item.kind, if item.kind == "channel" && !item.label.is_empty() { item.label.to_lowercase() } else { item.value.to_lowercase() })));
}

fn add_block(kind: String, value: String, label: String, thumbnail: String, app: tauri::AppHandle) -> Result<(), String> {
  if value.is_empty() { return Ok(()); }
  let mut blocks = read_blocks(&app)?;
  dedupe_blocks(&mut blocks);
  if let Some(item) = blocks.iter_mut().find(|item| item.kind == kind && (item.value.eq_ignore_ascii_case(&value) || kind == "channel" && !label.is_empty() && item.label.eq_ignore_ascii_case(&label))) { if item.label.is_empty() { item.label = label; } if item.thumbnail.is_empty() { item.thumbnail = thumbnail; } }
  else { blocks.push(BlockedItem { kind, value, label, thumbnail }); }
  fs::write(blocks_path(&app)?, serde_json::to_string_pretty(&blocks).map_err(|error| error.to_string())?).map_err(|error| error.to_string())
}

#[tauri::command]
fn list_subscriptions(app: tauri::AppHandle) -> Result<Vec<Subscription>, String> { read_subscriptions(&app) }

#[tauri::command]
fn list_blocks(app: tauri::AppHandle) -> Result<Vec<BlockedItem>, String> { let mut blocks = read_blocks(&app)?; dedupe_blocks(&mut blocks); fs::write(blocks_path(&app)?, serde_json::to_string_pretty(&blocks).map_err(|error| error.to_string())?).map_err(|error| error.to_string())?; Ok(blocks) }

#[tauri::command]
fn block_video(id: String, label: Option<String>, thumbnail: Option<String>, app: tauri::AppHandle) -> Result<(), String> { let fallback_thumbnail = format!("https://i.ytimg.com/vi/{id}/hqdefault.jpg"); add_block("video".into(), id.clone(), label.filter(|value| !value.is_empty()).unwrap_or_else(|| id.clone()), thumbnail.filter(|value| !value.is_empty()).unwrap_or(fallback_thumbnail), app) }

#[tauri::command]
fn block_channel(channel: String, channel_id: String, thumbnail: Option<String>, app: tauri::AppHandle) -> Result<(), String> { let value = if channel_id.is_empty() { channel.clone() } else { channel_id }; add_block("channel".into(), value, channel, thumbnail.unwrap_or_default(), app) }

#[tauri::command]
fn unblock_item(kind: String, value: String, app: tauri::AppHandle) -> Result<(), String> {
  let mut blocks = read_blocks(&app)?;
  blocks.retain(|item| item.kind != kind || item.value != value);
  fs::write(blocks_path(&app)?, serde_json::to_string_pretty(&blocks).map_err(|error| error.to_string())?).map_err(|error| error.to_string())
}

#[tauri::command]
fn subscribe_channel(channel: String, channel_id: String, avatar: Option<String>, app: tauri::AppHandle) -> Result<(), String> {
  let mut subscriptions = read_subscriptions(&app)?;
  if let Some(item) = subscriptions.iter_mut().find(|item| item.channel.eq_ignore_ascii_case(&channel)) { if !channel_id.is_empty() { item.channel_id = channel_id; } if item.avatar.is_empty() { item.avatar = avatar.unwrap_or_default(); } }
  else if !channel.is_empty() { subscriptions.push(Subscription { channel, channel_id, avatar: avatar.unwrap_or_default() }); }
  let path = subscriptions_path(&app)?;
  fs::write(path, serde_json::to_string_pretty(&subscriptions).map_err(|error| error.to_string())?).map_err(|error| error.to_string())
}

#[tauri::command]
fn unsubscribe_channel(channel: String, app: tauri::AppHandle) -> Result<(), String> {
  let mut subscriptions = read_subscriptions(&app)?;
  subscriptions.retain(|item| !item.channel.eq_ignore_ascii_case(&channel));
  let path = subscriptions_path(&app)?;
  fs::write(path, serde_json::to_string_pretty(&subscriptions).map_err(|error| error.to_string())?).map_err(|error| error.to_string())
}

fn text(value: Option<&Value>) -> String {
  value.and_then(|v| v.get("simpleText").and_then(Value::as_str).map(str::to_owned).or_else(|| v.get("runs").and_then(Value::as_array).and_then(|runs| runs.first()).and_then(|run| run.get("text")).and_then(Value::as_str).map(str::to_owned))).unwrap_or_default()
}

fn initial_data(html: &str) -> Option<Value> {
  let marker = "var ytInitialData = ";
  let start = html.find(marker)? + marker.len();
  let json = &html[start..];
  let first = json.find('{')?;
  let bytes = json.as_bytes();
  let mut depth = 0usize;
  let mut quote = false;
  let mut escaped = false;
  for (index, byte) in bytes.iter().enumerate().skip(first) {
    if quote { if escaped { escaped = false; } else if *byte == b'\\' { escaped = true; } else if *byte == b'"' { quote = false; } continue; }
    match byte { b'"' => quote = true, b'{' => depth += 1, b'}' => { depth -= 1; if depth == 0 { return serde_json::from_str(&json[first..=index]).ok(); } }, _ => {} }
  }
  None
}

fn config_value(html: &str, name: &str) -> Option<String> {
  let marker = format!("\"{name}\":\"");
  let start = html.find(&marker)? + marker.len();
  let end = html[start..].find('"')? + start;
  Some(html[start..end].to_owned())
}

fn continuation(value: &Value) -> Option<String> {
  if let Some(token) = value.get("continuationCommand").and_then(|item| item.get("token")).and_then(Value::as_str) { return Some(token.to_owned()); }
  match value { Value::Array(items) => items.iter().find_map(continuation), Value::Object(items) => items.values().find_map(continuation), _ => None }
}

fn browse_id(value: Option<&Value>) -> String {
  value.and_then(|item| item.get("runs")).and_then(Value::as_array).and_then(|runs| runs.iter().find_map(|run| run.get("navigationEndpoint").and_then(|endpoint| endpoint.get("browseEndpoint")).and_then(|endpoint| endpoint.get("browseId")).and_then(Value::as_str))).unwrap_or_default().to_owned()
}

fn result_from_renderer(id: &str, title: Option<&Value>, channel: Option<&Value>, duration: Option<&Value>, thumbnail: Option<&Value>) -> SearchResult {
  SearchResult { id: id.to_owned(), title: text(title), channel: text(channel), channel_id: browse_id(channel), duration: text(duration), thumbnail: thumbnail.and_then(|v| v.get("thumbnails")).and_then(Value::as_array).and_then(|items| items.first()).and_then(|item| item.get("url")).and_then(Value::as_str).unwrap_or_default().to_owned() }
}

fn collect_results(value: &Value, results: &mut Vec<SearchResult>, seen: &mut HashSet<String>) {
  if results.len() >= 30 { return; }
  if let Some(renderer) = value.get("reelWatchEndpoint") {
    let id = renderer.get("videoId").and_then(Value::as_str).unwrap_or_default();
    if !id.is_empty() && seen.insert(id.to_owned()) {
      let thumbnail = renderer.get("thumbnail").and_then(|item| item.get("thumbnails")).and_then(Value::as_array).and_then(|items| items.first()).and_then(|item| item.get("url")).and_then(Value::as_str).map(str::to_owned).unwrap_or_else(|| format!("https://i.ytimg.com/vi/{id}/hqdefault.jpg"));
      results.push(SearchResult { id: id.to_owned(), title: "YouTube Short".to_owned(), channel: String::new(), channel_id: String::new(), duration: String::new(), thumbnail });
    }
  }
  if let Some(renderer) = value.get("videoRenderer") {
    let id = renderer.get("videoId").and_then(Value::as_str).unwrap_or_default();
    if !id.is_empty() && seen.insert(id.to_owned()) {
      results.push(result_from_renderer(id, renderer.get("title"), renderer.get("ownerText").or_else(|| renderer.get("longBylineText")), renderer.get("lengthText"), renderer.get("thumbnail")));
    }
  }
  if let Some(renderer) = value.get("reelItemRenderer") {
    let id = renderer.get("videoId").and_then(Value::as_str).unwrap_or_default();
    if !id.is_empty() && seen.insert(id.to_owned()) { results.push(result_from_renderer(id, renderer.get("headline").or_else(|| renderer.get("title")), renderer.get("ownerText").or_else(|| renderer.get("longBylineText")), renderer.get("lengthText"), renderer.get("thumbnail"))); }
  }
  if let Some(renderer) = value.get("gridVideoRenderer") {
    let id = renderer.get("videoId").and_then(Value::as_str).unwrap_or_default();
    if !id.is_empty() && seen.insert(id.to_owned()) { results.push(result_from_renderer(id, renderer.get("title"), renderer.get("shortBylineText").or_else(|| renderer.get("longBylineText")), renderer.get("lengthText"), renderer.get("thumbnail"))); }
  }
  if let Some(lockup) = value.get("lockupViewModel") {
    let thumbnail = lockup.get("contentImage").and_then(|item| item.get("thumbnailViewModel")).and_then(|item| item.get("image")).and_then(|item| item.get("sources")).and_then(Value::as_array).and_then(|items| items.first()).and_then(|item| item.get("url")).and_then(Value::as_str).unwrap_or_default();
    let id = thumbnail.split("/vi/").nth(1).and_then(|item| item.split('/').next()).unwrap_or_default();
    if !id.is_empty() && seen.insert(id.to_owned()) { results.push(SearchResult { id: id.to_owned(), title: lockup.get("metadata").and_then(|item| item.get("lockupMetadataViewModel")).and_then(|item| item.get("title")).and_then(|item| item.get("content")).and_then(Value::as_str).unwrap_or_default().to_owned(), channel: String::new(), channel_id: String::new(), duration: String::new(), thumbnail: thumbnail.to_owned() }); }
  }
  match value { Value::Array(items) => for item in items { collect_results(item, results, seen); }, Value::Object(items) => for item in items.values() { collect_results(item, results, seen); }, _ => {} }
}

fn collect_reel_results(html: &str, results: &mut Vec<SearchResult>, seen: &mut HashSet<String>) {
  for marker in [r#""reelWatchEndpoint":{"videoId":""#, r#"\"reelWatchEndpoint\":{\"videoId\":\""#, r#"reelWatchEndpoint\x22:\x7b\x22videoId\x22:\x22"#] {
    let mut remainder = html;
    while results.len() < 30 {
      let Some(index) = remainder.find(marker) else { break; };
      let value = &remainder[index + marker.len()..];
      let length = value.bytes().take_while(|byte| byte.is_ascii_alphanumeric() || *byte == b'_' || *byte == b'-').count();
      let id = &value[..length];
      if !id.is_empty() && seen.insert(id.to_owned()) { results.push(SearchResult { id: id.to_owned(), title: "YouTube Short".to_owned(), channel: String::new(), channel_id: String::new(), duration: String::new(), thumbnail: format!("https://i.ytimg.com/vi/{id}/hqdefault.jpg") }); }
      remainder = &value[length..];
    }
  }
}

fn search_youtube_sync(query: String, state: &SearchState) -> Result<SearchPage, String> {
  let response = reqwest::blocking::Client::builder().user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36").build().map_err(|e| e.to_string())?.get("https://www.youtube.com/results").query(&[("search_query", query), ("hl", "en".to_string()), ("gl", "US".to_string())]).send().map_err(|e| format!("YouTube search request failed: {e}"))?.error_for_status().map_err(|e| format!("YouTube search failed: {e}"))?.text().map_err(|e| e.to_string())?;
  let data = initial_data(&response).ok_or("YouTube did not return search data")?;
  let mut results = Vec::new();
  collect_results(&data, &mut results, &mut HashSet::new());
  let cursor = if let (Some(token), Some(api_key), Some(client_version)) = (continuation(&data), config_value(&response, "INNERTUBE_API_KEY"), config_value(&response, "INNERTUBE_CONTEXT_CLIENT_VERSION")) {
    let key = NEXT_CURSOR.fetch_add(1, Ordering::Relaxed).to_string();
    let mut cursors = state.0.lock().map_err(|_| "search state unavailable")?;
    cursors.clear();
    cursors.insert(key.clone(), SearchCursor { token, api_key, client_version, visitor_data: config_value(&response, "VISITOR_DATA").unwrap_or_default() });
    Some(key)
  } else { None };
  Ok(SearchPage { results, cursor })
}

fn search_youtube_more_sync(cursor: String, state: &SearchState) -> Result<SearchPage, String> {
  let current = state.0.lock().map_err(|_| "search state unavailable")?.remove(&cursor).ok_or("Search has no more results")?;
  let client_version = current.client_version.clone();
  let body = serde_json::json!({ "context": { "client": { "clientName": "WEB", "clientVersion": client_version, "visitorData": current.visitor_data } }, "continuation": current.token });
  let response: Value = reqwest::blocking::Client::builder().user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36").build().map_err(|e| e.to_string())?.post(format!("https://www.youtube.com/youtubei/v1/search?prettyPrint=false&key={}", current.api_key)).header("X-YouTube-Client-Name", "1").header("X-YouTube-Client-Version", &current.client_version).json(&body).send().map_err(|e| format!("YouTube continuation request failed: {e}"))?.error_for_status().map_err(|e| format!("YouTube continuation failed: {e}"))?.json().map_err(|e| e.to_string())?;
  let mut results = Vec::new();
  collect_results(&response, &mut results, &mut HashSet::new());
  if let Some(token) = continuation(&response) {
    state.0.lock().map_err(|_| "search state unavailable")?.insert(cursor.clone(), SearchCursor { token, ..current });
    Ok(SearchPage { results, cursor: Some(cursor) })
  } else { Ok(SearchPage { results, cursor: None }) }
}

fn browse_youtube_data(browse_id: String, params: Option<String>) -> Result<Value, String> {
  let client = reqwest::blocking::Client::builder().user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36").build().map_err(|e| e.to_string())?;
  let page = client.get("https://www.youtube.com/feed/shorts").query(&[("hl", "en"), ("gl", "US")]).send().map_err(|e| format!("YouTube browse request failed: {e}"))?.error_for_status().map_err(|e| format!("YouTube browse failed: {e}"))?.text().map_err(|e| e.to_string())?;
  let api_key = config_value(&page, "INNERTUBE_API_KEY").ok_or("YouTube did not provide a browse API key")?;
  let client_version = config_value(&page, "INNERTUBE_CONTEXT_CLIENT_VERSION").ok_or("YouTube did not provide a browse client version")?;
  let mut body = serde_json::json!({ "context": { "client": { "clientName": "WEB", "clientVersion": client_version, "hl": "en", "gl": "US" } }, "browseId": browse_id });
  if let Some(params) = params { body["params"] = Value::String(params); }
  client.post(format!("https://www.youtube.com/youtubei/v1/browse?prettyPrint=false&key={api_key}")).header("X-YouTube-Client-Name", "1").header("X-YouTube-Client-Version", &client_version).json(&body).send().map_err(|e| format!("YouTube browse feed request failed: {e}"))?.error_for_status().map_err(|e| format!("YouTube browse feed failed: {e}"))?.json().map_err(|e| e.to_string())
}

fn page_from_browse(response: Value) -> SearchPage {
  let mut results = Vec::new();
  collect_results(&response, &mut results, &mut HashSet::new());
  SearchPage { results, cursor: None }
}

fn browse_tab_params(value: &Value, title: &str) -> Option<String> {
  if let Some(tab) = value.get("tabRenderer") {
    if tab.get("title").and_then(Value::as_str).map(str::to_owned).unwrap_or_else(|| text(tab.get("title"))) == title { return tab.get("endpoint").and_then(|endpoint| endpoint.get("browseEndpoint")).and_then(|endpoint| endpoint.get("params")).and_then(Value::as_str).map(str::to_owned); }
  }
  match value { Value::Array(items) => items.iter().find_map(|item| browse_tab_params(item, title)), Value::Object(items) => items.values().find_map(|item| browse_tab_params(item, title)), _ => None }
}

fn channel_tab_sync(channel_id: String, title: &str) -> Result<SearchPage, String> {
  let page = reqwest::blocking::Client::builder().user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36").build().map_err(|e| e.to_string())?.get(format!("https://www.youtube.com/channel/{channel_id}/{}", title.to_lowercase())).query(&[("hl", "en"), ("gl", "US")]).send().map_err(|e| format!("YouTube channel request failed: {e}"))?.error_for_status().map_err(|e| format!("YouTube channel request failed: {e}"))?.text().map_err(|e| e.to_string())?;
  Ok(page_from_browse(initial_data(&page).ok_or("YouTube did not return channel data")?))
}

fn subscription_shorts_sync(mut subscriptions: Vec<Subscription>) -> Result<(SearchPage, Vec<Subscription>), String> {
  let mut results = Vec::new();
  let mut seen = HashSet::new();
  for subscription in &mut subscriptions {
    if subscription.channel_id.is_empty() { subscription.channel_id = channel_id_sync(&subscription.channel)?; }
    collect_results(&initial_data(&reqwest::blocking::Client::builder().user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36").build().map_err(|e| e.to_string())?.get(format!("https://www.youtube.com/channel/{}/shorts", subscription.channel_id)).query(&[("hl", "en"), ("gl", "US")]).send().map_err(|e| format!("YouTube Shorts request failed: {e}"))?.error_for_status().map_err(|e| format!("YouTube Shorts failed: {e}"))?.text().map_err(|e| e.to_string())?).ok_or("YouTube did not return Shorts data")?, &mut results, &mut seen);
    if results.len() >= 30 { break; }
  }
  Ok((SearchPage { results, cursor: None }, subscriptions))
}

fn shorts_sync() -> Result<SearchPage, String> {
  let client = reqwest::blocking::Client::builder().user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36").build().map_err(|e| e.to_string())?;
  let page = client.get("https://www.youtube.com/shorts/").query(&[("hl", "en"), ("gl", "US")]).send().map_err(|e| format!("YouTube Shorts request failed: {e}"))?.error_for_status().map_err(|e| format!("YouTube Shorts failed: {e}"))?.text().map_err(|e| e.to_string())?;
  let mut results = Vec::new();
  let mut seen = HashSet::new();
  if let Some(data) = initial_data(&page) { collect_results(&data, &mut results, &mut seen); }
  collect_reel_results(&page, &mut results, &mut seen);
  Ok(SearchPage { results, cursor: None })
}

fn shorts_more_sync(video_id: String) -> Result<SearchPage, String> {
  let page = reqwest::blocking::Client::builder().user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36").build().map_err(|e| e.to_string())?.get(format!("https://www.youtube.com/shorts/{video_id}")).query(&[("hl", "en"), ("gl", "US")]).send().map_err(|e| format!("YouTube Shorts request failed: {e}"))?.error_for_status().map_err(|e| format!("YouTube Shorts failed: {e}"))?.text().map_err(|e| e.to_string())?;
  let mut results = Vec::new();
  collect_reel_results(&page, &mut results, &mut HashSet::new());
  Ok(SearchPage { results, cursor: None })
}

fn subscription_videos_sync(mut subscriptions: Vec<Subscription>) -> Result<(SearchPage, Vec<Subscription>), String> {
  let mut results = Vec::new();
  let mut seen = HashSet::new();
  for subscription in &mut subscriptions {
    if subscription.channel_id.is_empty() { subscription.channel_id = channel_id_sync(&subscription.channel)?; }
    collect_results(&initial_data(&reqwest::blocking::Client::builder().user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36").build().map_err(|e| e.to_string())?.get(format!("https://www.youtube.com/channel/{}/videos", subscription.channel_id)).query(&[("hl", "en"), ("gl", "US")]).send().map_err(|e| format!("YouTube Home request failed: {e}"))?.error_for_status().map_err(|e| format!("YouTube Home failed: {e}"))?.text().map_err(|e| e.to_string())?).ok_or("YouTube did not return Home data")?, &mut results, &mut seen);
    if results.len() >= 30 { break; }
  }
  if results.is_empty() { return Ok((search_youtube_sync("music".into(), &SearchState(Arc::new(Mutex::new(HashMap::new()))))?, subscriptions)); }
  Ok((SearchPage { results, cursor: None }, subscriptions))
}

fn channel_id_sync(channel: &str) -> Result<String, String> {
  let client = reqwest::blocking::Client::builder().user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36").build().map_err(|e| e.to_string())?;
  let page = client.get("https://www.youtube.com/results").query(&[("search_query", channel), ("hl", "en"), ("gl", "US")]).send().map_err(|e| format!("YouTube channel lookup failed: {e}"))?.error_for_status().map_err(|e| format!("YouTube channel lookup failed: {e}"))?.text().map_err(|e| e.to_string())?;
  let data = initial_data(&page).ok_or("YouTube did not return channel lookup data")?;
  let mut results = Vec::new();
  collect_results(&data, &mut results, &mut HashSet::new());
  results.iter().find(|result| result.channel.eq_ignore_ascii_case(channel) && !result.channel_id.is_empty()).or_else(|| results.iter().find(|result| !result.channel_id.is_empty())).map(|result| result.channel_id.clone()).ok_or_else(|| "Could not find that channel's YouTube ID".to_owned())
}

fn channel_avatar_sync(channel_id: String) -> Result<String, String> {
  let page = reqwest::blocking::Client::builder().user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36").build().map_err(|e| e.to_string())?.get(format!("https://www.youtube.com/channel/{channel_id}")).query(&[("hl", "en"), ("gl", "US")]).send().map_err(|e| format!("YouTube channel request failed: {e}"))?.error_for_status().map_err(|e| format!("YouTube channel request failed: {e}"))?.text().map_err(|e| e.to_string())?;
  let from_meta = page.find("property=\"og:image\"").and_then(|index| page[index..].find("content=\"").map(|offset| &page[index + offset + 9..])).and_then(|value| value.find('"').map(|end| value[..end].to_owned()));
  let from_image = ["https://yt3.ggpht.com/", "https://yt3.googleusercontent.com/"].iter().find_map(|marker| page.find(marker).and_then(|index| { let value = &page[index..]; value.find('"').map(|end| value[..end].to_owned()) }));
  from_meta.or(from_image).map(|value| value.replace("\\u0026", "&")).ok_or("YouTube did not return a channel avatar".into())
}

#[tauri::command]
async fn search_youtube(query: String, state: tauri::State<'_, SearchState>) -> Result<SearchPage, String> {
  let shared = state.0.clone();
  tauri::async_runtime::spawn_blocking(move || search_youtube_sync(query, &SearchState(shared))).await.map_err(|error| error.to_string())?
}

#[tauri::command]
async fn search_youtube_more(cursor: String, state: tauri::State<'_, SearchState>) -> Result<SearchPage, String> {
  let shared = state.0.clone();
  tauri::async_runtime::spawn_blocking(move || search_youtube_more_sync(cursor, &SearchState(shared))).await.map_err(|error| error.to_string())?
}

#[tauri::command]
async fn load_shorts(app: tauri::AppHandle) -> Result<SearchPage, String> {
  let page = tauri::async_runtime::spawn_blocking(shorts_sync).await.map_err(|error| error.to_string())??;
  if !page.results.is_empty() { return Ok(page); }
  let subscriptions = read_subscriptions(&app)?;
  let (page, subscriptions) = tauri::async_runtime::spawn_blocking(move || subscription_shorts_sync(subscriptions)).await.map_err(|error| error.to_string())??;
  fs::write(subscriptions_path(&app)?, serde_json::to_string_pretty(&subscriptions).map_err(|error| error.to_string())?).map_err(|error| error.to_string())?;
  Ok(page)
}

#[tauri::command]
async fn load_shorts_more(video_id: String) -> Result<SearchPage, String> {
  tauri::async_runtime::spawn_blocking(move || shorts_more_sync(video_id)).await.map_err(|error| error.to_string())?
}

#[tauri::command]
async fn load_home(app: tauri::AppHandle) -> Result<SearchPage, String> {
  let subscriptions = read_subscriptions(&app)?;
  let (page, subscriptions) = tauri::async_runtime::spawn_blocking(move || subscription_videos_sync(subscriptions)).await.map_err(|error| error.to_string())??;
  fs::write(subscriptions_path(&app)?, serde_json::to_string_pretty(&subscriptions).map_err(|error| error.to_string())?).map_err(|error| error.to_string())?;
  Ok(page)
}

#[tauri::command]
async fn load_channel_videos(channel: String, channel_id: String, app: tauri::AppHandle) -> Result<SearchPage, String> {
  let lookup_channel = channel.clone();
  let resolved_id = tauri::async_runtime::spawn_blocking(move || if channel_id.is_empty() { channel_id_sync(&lookup_channel) } else { Ok(channel_id) }).await.map_err(|error| error.to_string())??;
  let resolved_channel = channel;
  let browse_id = resolved_id.clone();
  let page = tauri::async_runtime::spawn_blocking(move || channel_tab_sync(browse_id, "Videos")).await.map_err(|error| error.to_string())??;
  let mut subscriptions = read_subscriptions(&app)?;
  if let Some(item) = subscriptions.iter_mut().find(|item| item.channel.eq_ignore_ascii_case(&resolved_channel)) { item.channel_id = resolved_id; }
  fs::write(subscriptions_path(&app)?, serde_json::to_string_pretty(&subscriptions).map_err(|error| error.to_string())?).map_err(|error| error.to_string())?;
  Ok(page)
}

#[tauri::command]
async fn load_subscription_avatar(channel: String, channel_id: String, app: tauri::AppHandle) -> Result<String, String> {
  let lookup_channel = channel.clone();
  let resolved_id = tauri::async_runtime::spawn_blocking(move || if channel_id.is_empty() { channel_id_sync(&lookup_channel) } else { Ok(channel_id) }).await.map_err(|error| error.to_string())??;
  let avatar_id = resolved_id.clone();
  let avatar = tauri::async_runtime::spawn_blocking(move || channel_avatar_sync(avatar_id)).await.map_err(|error| error.to_string())??;
  let mut subscriptions = read_subscriptions(&app)?;
  if let Some(item) = subscriptions.iter_mut().find(|item| item.channel.eq_ignore_ascii_case(&channel)) { item.channel_id = resolved_id; item.avatar = avatar.clone(); }
  fs::write(subscriptions_path(&app)?, serde_json::to_string_pretty(&subscriptions).map_err(|error| error.to_string())?).map_err(|error| error.to_string())?;
  Ok(avatar)
}

#[tauri::command]
fn minimize_window(window: WebviewWindow) -> Result<(), String> { window.minimize().map_err(|error| error.to_string()) }

#[tauri::command]
fn hide_window(window: WebviewWindow) -> Result<(), String> { window.hide().map_err(|error| error.to_string()) }

#[tauri::command]
fn toggle_maximize(window: WebviewWindow) -> Result<(), String> {
  if window.is_maximized().map_err(|error| error.to_string())? { window.unmaximize().map_err(|error| error.to_string()) }
  else { window.maximize().map_err(|error| error.to_string()) }
}

#[tauri::command]
fn drag_window(window: WebviewWindow) -> Result<(), String> { window.start_dragging().map_err(|error| error.to_string()) }

#[tauri::command]
fn set_input_lock(locked: bool) { INPUT_LOCKED.store(locked, Ordering::Relaxed); }

const PLAYER_GUARD: &str = r#"(function () {
  if (!/(^|\.)youtube(?:-nocookie)?\.com$/.test(location.hostname)) return;
  const blockedHosts = /(^|\.)(doubleclick\.net|googlesyndication\.com|googleadservices\.com|google-analytics\.com|googletagmanager\.com|adservice\.google\.com)$/i;
  const blockedPath = /(?:\/pagead\/|\/ptracking|\/api\/stats\/ads|\/api\/stats\/qoe|\/youtubei\/v1\/(?:log_event|visitor_id)|\/generate_204)/i;
  const shouldBlock = value => { try { const url = new URL(String(value), location.href); return blockedHosts.test(url.hostname) || blockedPath.test(url.pathname); } catch { return false; } };
  const fetch = window.fetch.bind(window); window.fetch = function (input, init) { return shouldBlock(input instanceof Request ? input.url : input) ? Promise.resolve(new Response('', { status: 204, statusText: 'No Content' })) : fetch(input, init); };
  const beacon = navigator.sendBeacon && navigator.sendBeacon.bind(navigator); if (beacon) navigator.sendBeacon = (url, data) => shouldBlock(url) ? true : beacon(url, data);
  const hide = () => { document.querySelectorAll('.ytp-ad-module,.ytp-ad-player-overlay,.ytp-ad-text,.ytp-ad-skip-button-container,.video-ads,ytd-promoted-sparkles-web-renderer,ytd-display-ad-renderer,ytd-ad-slot-renderer').forEach(node => node.remove()); };
  const sendShortInfo = () => { const channel = document.querySelector('.ytmVideoInfoChannelTitle'); const href = channel?.getAttribute('href') || ''; const channelId = href.match(/\/channel\/([^/?]+)/)?.[1] || ''; const videoId = new URL(location.href).searchParams.get('v') || location.pathname.match(/\/(?:embed|shorts)\/([^/?]+)/)?.[1] || ''; if (videoId) parent.postMessage({ source: 'tauritube', action: 'short-info', videoId, channel: channel?.textContent?.trim() || '', channelId }, '*'); };
  const addBack = () => { if (!new URLSearchParams(location.search).has('tauritube_shorts')) return; const host = document.querySelector('player-top-controls.ytwPlayerTopControlsHost, .ytwPlayerTopControlsHost'); const right = host && host.querySelector('.ytwPlayerTopControlsPlayerControlsTopRight, .player-controls-top-right'); if (!right || right.dataset.ytTauriBack) return; right.dataset.ytTauriBack = '1'; let style = document.getElementById('yt-tauri-back-style'); if (!style) { style = document.createElement('style'); style.id = 'yt-tauri-back-style'; style.textContent = '.ytwPlayerTopControlsPlayerControlsTopRight[data-yt-tauri-back]::before,.player-controls-top-right[data-yt-tauri-back]::before{content:"‹";width:38px;height:38px;display:flex;align-items:center;justify-content:center;background:transparent;color:#fff;font:bold 38px/1 Arial,sans-serif;cursor:pointer;flex:0 0 38px;margin-right:8px}'; document.head.append(style); } right.addEventListener('click', event => { const rect = right.getBoundingClientRect(); if (event.clientX > rect.left + 46) return; event.preventDefault(); event.stopImmediatePropagation(); parent.postMessage({ source: 'youtube-tauri', action: 'back' }, '*'); }, true); };
  const addMobileBack = () => { const host = document.querySelector('.ytmVideoInfoVideoDetailsContainer'); if (!host || document.getElementById('yt-tauri-mobile-back')) return; document.documentElement.classList.add('yt-tauri-mobile-info'); const button = document.createElement('button'); button.id = 'yt-tauri-mobile-back'; button.type = 'button'; button.ariaLabel = 'Back to Tauritube'; button.textContent = '‹'; const place = () => { const rect = host.getBoundingClientRect(); button.style.left = `${Math.max(8, rect.left - 42)}px`; button.style.top = `${rect.top + 7}px`; }; button.addEventListener('pointerdown', event => { event.preventDefault(); event.stopImmediatePropagation(); parent.postMessage({ source: 'youtube-tauri', action: 'back' }, '*'); }, true); button.addEventListener('click', event => { event.preventDefault(); event.stopImmediatePropagation(); }, true); let style = document.getElementById('yt-tauri-mobile-back-style'); if (!style) { style = document.createElement('style'); style.id = 'yt-tauri-mobile-back-style'; style.textContent = '.ytmVideoInfoVideoDetailsContainer{transform:translateX(46px)!important}html.yt-tauri-mobile-info .ytwPlayerTopControlsPlayerControlsTopRight[data-yt-tauri-back]::before,html.yt-tauri-mobile-info .player-controls-top-right[data-yt-tauri-back]::before{display:none!important}#yt-tauri-mobile-back{position:fixed!important;z-index:2147483647!important;display:grid!important;place-items:center!important;width:38px!important;height:38px!important;margin:0!important;padding:0!important;border:0!important;background:transparent!important;color:#fff!important;font:38px/1 Arial,sans-serif!important;cursor:pointer!important;pointer-events:auto!important;transition:opacity .15s ease!important}html.yt-tauri-controls-hidden #yt-tauri-mobile-back{opacity:0!important;visibility:hidden!important;pointer-events:none!important}'; document.head.append(style); } host.parentElement?.append(button); requestAnimationFrame(place); addEventListener('resize', place, { passive: true }); };
  const addBlock = () => { const host = document.querySelector('player-top-controls.ytwPlayerTopControlsHost, .ytwPlayerTopControlsHost'); const right = host && host.querySelector('.ytwPlayerTopControlsPlayerControlsTopRight, .player-controls-top-right'); if (!right || document.getElementById('yt-tauri-block')) return; const button = document.createElement('button'); button.id = 'yt-tauri-block'; button.type = 'button'; button.ariaLabel = 'Block'; button.textContent = '⊘'; const menu = document.createElement('div'); menu.id = 'yt-tauri-block-menu'; const info = () => { const channel = document.querySelector('.ytmVideoInfoChannelTitle'); const href = channel?.getAttribute('href') || ''; return { videoId: new URL(location.href).searchParams.get('v') || location.pathname.match(/\/(?:embed|shorts)\/([^/?]+)/)?.[1] || '', channel: channel?.textContent?.trim() || '', channelId: href.match(/\/channel\/([^/?]+)/)?.[1] || '' }; }; const add = (label, action) => { const item = document.createElement('button'); item.textContent = label; item.addEventListener('click', event => { event.preventDefault(); event.stopImmediatePropagation(); parent.postMessage({ source: 'tauritube', action, ...info() }, '*'); }); menu.append(item); }; add('Block video', 'block-video'); add('Block channel', 'block-channel'); button.addEventListener('click', event => { event.preventDefault(); event.stopImmediatePropagation(); menu.classList.toggle('open'); }); let style = document.getElementById('yt-tauri-block-style'); if (!style) { style = document.createElement('style'); style.id = 'yt-tauri-block-style'; style.textContent = '.ytwPlayerTopControlsPlayerControlsTopRight,.player-controls-top-right{position:relative!important}#yt-tauri-block{width:38px;height:38px;display:grid;place-items:center;transform:translateY(4px);background:transparent;border:0;color:#fff;font:24px/1 Arial,sans-serif;cursor:pointer}#yt-tauri-block-menu{display:none;position:absolute;top:42px;right:0;z-index:2147483647;padding:5px;border-radius:6px;background:#171717;box-shadow:0 8px 22px rgba(0,0,0,.55)}#yt-tauri-block-menu.open{display:grid;gap:4px}#yt-tauri-block-menu button{padding:7px 9px;border:0;border-radius:4px;background:#2b2b2b;color:#fff;white-space:nowrap;font:12px system-ui;cursor:pointer}#yt-tauri-block-menu button:hover{background:#832222}'; document.head.append(style); } right.prepend(button, menu); };
  const addMini = () => { const right = document.querySelector('player-bottom-controls .player-controls-bottom-right'); if (!right || right.dataset.ytTauriMini) return; right.dataset.ytTauriMini = '1'; const popout = document.createElement('button'); popout.id = 'yt-tauri-popout'; popout.type = 'button'; popout.ariaLabel = 'Picture in picture'; popout.textContent = '↗'; popout.addEventListener('click', event => { event.preventDefault(); event.stopImmediatePropagation(); document.querySelector('video')?.requestPictureInPicture?.().catch(() => {}); }, true); right.prepend(popout); let style = document.getElementById('yt-tauri-mini-style'); if (!style) { style = document.createElement('style'); style.id = 'yt-tauri-mini-style'; style.textContent = '.player-controls-bottom-right[data-yt-tauri-mini]{display:flex;align-items:center}.player-controls-bottom-right[data-yt-tauri-mini]::before,#yt-tauri-popout{width:38px;height:38px;display:flex;align-items:center;justify-content:center;color:#fff;font:25px/1 Arial,sans-serif;cursor:pointer;flex:0 0 38px;background:transparent;border:0} .player-controls-bottom-right[data-yt-tauri-mini]::before{content:"◲"}'; document.head.append(style); } right.addEventListener('click', event => { const rect = right.getBoundingClientRect(); if (event.clientX > rect.left + 42) return; event.preventDefault(); event.stopImmediatePropagation(); parent.postMessage({ source: 'youtube-tauri', action: 'mini', time: document.querySelector('video')?.currentTime || 0 }, '*'); }, true); };
  document.addEventListener('mousedown', event => { if (event.button !== 0 || event.clientY > 170 || event.target.closest('button,a,input,[role="button"],.ytwPlayerTopControlsPlayerControlsTopRight,.player-controls-top-right')) return; parent.postMessage({ source: 'youtube-tauri', action: 'drag' }, '*'); }, true);
  let refreshQueued = false; new MutationObserver(() => { if (refreshQueued) return; refreshQueued = true; requestAnimationFrame(() => { refreshQueued = false; hide(); sendShortInfo(); addBack(); addMobileBack(); addBlock(); addMini(); }); }).observe(document, { childList: true, subtree: true }); hide(); sendShortInfo(); addBack(); addMobileBack(); addBlock(); addMini(); addEventListener('message', event => { if (event.data?.source === 'tauritube' && event.data?.action === 'mini-state') document.documentElement.classList.toggle('yt-tauri-mini', Boolean(event.data.mini)); });
  let locked = false, cover, controlsSuppressed = false, controlsHideTimer; const setControlsHidden = () => document.documentElement.classList.toggle('yt-tauri-controls-hidden', locked || controlsSuppressed); const installControlsStyle = () => { if (document.getElementById('yt-tauri-controls-style')) return; const parent = document.head || document.documentElement; if (!parent) return; const style = document.createElement('style'); style.id = 'yt-tauri-controls-style'; style.textContent = '#player-control-overlay,#player-controls .ytPlayerProgressBarHost{transition:opacity .15s ease!important}html.yt-tauri-controls-hidden #player-control-overlay,html.yt-tauri-controls-hidden #player-controls .ytPlayerProgressBarHost,html.yt-tauri-mini #yt-tauri-mobile-back{opacity:0!important;visibility:hidden!important;pointer-events:none!important}'; parent.append(style); }; installControlsStyle(); document.addEventListener('DOMContentLoaded', installControlsStyle, { once: true }); const scheduleControlsHide = () => { if (locked || controlsSuppressed) return; clearTimeout(controlsHideTimer); controlsHideTimer = setTimeout(() => { document.documentElement.classList.add('yt-tauri-controls-hidden'); document.querySelector('#player-controls-a11y-toggle')?.click(); }, 300); }; document.addEventListener('pointermove', event => { if (locked || controlsSuppressed) return; document.documentElement.classList.remove('yt-tauri-controls-hidden'); if (event.target.closest('#player-controls,player-top-controls,player-middle-controls,player-bottom-controls,yt-progress-bar')) { clearTimeout(controlsHideTimer); return; } scheduleControlsHide(); }, true);
  if (new URLSearchParams(location.search).has('tauritube_shorts')) { const style = document.createElement('style'); style.textContent = 'html.yt-tauri-shorts-controls-hidden player-top-controls,html.yt-tauri-shorts-controls-hidden player-bottom-controls,html.yt-tauri-shorts-controls-hidden yt-progress-bar,html.yt-tauri-shorts-controls-hidden .ytmVideoInfoVideoDetailsContainer{opacity:0!important;visibility:hidden!important;pointer-events:none!important;transition:opacity .15s ease!important}'; document.head.append(style); let shortsControlsTimer; const hideShortsControls = () => { clearTimeout(shortsControlsTimer); document.documentElement.classList.remove('yt-tauri-shorts-controls-hidden'); shortsControlsTimer = setTimeout(() => document.documentElement.classList.add('yt-tauri-shorts-controls-hidden'), 1000); }; document.addEventListener('pointermove', hideShortsControls, true); hideShortsControls(); }
  const events = ['mousemove','mouseover','mouseenter','mousedown','mouseup','click','dblclick','contextmenu','pointerdown','pointerup','pointermove','pointerover','pointerenter','wheel','keydown','keyup','keypress','touchstart','touchmove','touchend'];
  const block = event => { event.preventDefault(); event.stopImmediatePropagation(); };
  const toast = text => { let node = document.getElementById('yt-tauri-toast'); if (!node) { node = document.createElement('div'); node.id = 'yt-tauri-toast'; node.style.cssText = 'position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:2147483647;padding:8px 14px;border-radius:6px;background:#111;color:#fff;font:13px system-ui;pointer-events:none'; document.documentElement.append(node); } node.textContent = text; clearTimeout(node._timer); node._timer = setTimeout(() => node.remove(), 1500); };
  const toggleControls = () => { controlsSuppressed = !controlsSuppressed; clearTimeout(controlsHideTimer); setControlsHidden(); toast(controlsSuppressed ? 'Player controls hidden — Shift+Z restores them' : 'Player controls restored'); };
  const toggleInput = () => { locked = !locked; clearTimeout(controlsHideTimer); setControlsHidden(); parent.postMessage({ source: 'youtube-tauri', action: 'input-lock', locked }, '*'); if (locked) { cover = document.createElement('div'); cover.id = 'yt-tauri-input-cover'; cover.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:transparent;pointer-events:auto;touch-action:none;cursor:none'; document.body.append(cover); events.forEach(type => document.addEventListener(type, block, true)); } else { cover && cover.remove(); events.forEach(type => document.removeEventListener(type, block, true)); } toast(locked ? 'Input disabled — Shift+X restores it' : 'Input restored'); };
  const shortcutsDown = new Set(); const shortcut = event => { const key = event.code === 'KeyX' || event.keyCode === 88 ? 'x' : event.code === 'KeyZ' || event.keyCode === 90 ? 'z' : ''; if (!key || !event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return; const run = key === 'x' ? toggleInput : toggleControls; if (event.type === 'keydown') { if (shortcutsDown.has(key)) return; shortcutsDown.add(key); run(); } else if (!shortcutsDown.has(key)) run(); else shortcutsDown.delete(key); event.preventDefault(); event.stopImmediatePropagation(); }; addEventListener('keydown', shortcut, true); addEventListener('keyup', shortcut, true);
  const overlayStyle = document.createElement('style'); overlayStyle.textContent = '.ytmVideoInfoOverlay.ytmVideoInfoExpanded{display:none!important}'; (document.head || document.documentElement).append(overlayStyle);
  document.addEventListener('click', event => { const target = event.target instanceof Element ? event.target.closest('.ytmVideoInfoChannelTitle,.ytmVideoInfoFlyoutChannelTitle,.ytmVideoInfoChannelAvatar') : null; if (!target) return; const link = target.closest('a.ytmVideoInfoChannelTitle') || document.querySelector('a.ytmVideoInfoChannelTitle'); const href = link?.getAttribute('href') || ''; const channelId = href.match(/\/channel\/([^/?]+)/)?.[1] || ''; const channel = link?.textContent?.trim() || document.querySelector('.ytmVideoInfoFlyoutChannelTitle')?.textContent?.trim() || ''; if (!channel && !channelId) return; event.preventDefault(); event.stopImmediatePropagation(); parent.postMessage({ source: 'youtube-tauri', action: 'open-channel', channel, channelId }, '*'); }, true);
})();"#;

#[tauri::command]
async fn check_for_update(app: tauri::AppHandle) -> Result<Option<String>, String> {
  use tauri_plugin_updater::UpdaterExt;
  let updater = app.updater().map_err(|error| error.to_string())?;
  updater.check().await.map(|update| update.map(|item| item.version)).map_err(|error| error.to_string())
}

#[tauri::command]
async fn do_update(app: tauri::AppHandle) -> Result<(), String> {
  use tauri_plugin_updater::UpdaterExt;
  let updater = app.updater().map_err(|error| error.to_string())?;
  let update = updater.check().await.map_err(|error| error.to_string())?.ok_or_else(|| "no_update_available".to_string())?;
  update.download_and_install(|_, _| {}, || {}).await.map_err(|error| error.to_string())?;
  app.restart();
}

pub fn run() {
  install_input_lock_hook().expect("Could not install the Windows-key input lock");
  tauri::Builder::default().setup(|app| {
    let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
      .title("Tauritube")
      .inner_size(1280.0, 720.0)
      .min_inner_size(640.0, 400.0)
      .center()
      .decorations(false)
      .additional_browser_args("--disable-background-networking --disable-component-update --disable-client-side-phishing-detection --disable-default-apps --disable-domain-reliability --disable-features=MediaRouter,OptimizationHints,AutofillServerCommunication --disable-sync --metrics-recording-only --no-first-run")
      .initialization_script_for_all_frames(PLAYER_GUARD)
      .build()?;
    let toggle_item = MenuItem::with_id(app, "toggle", "Show / Hide", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&toggle_item, &quit_item])?;
    let icon = app.default_window_icon().cloned().ok_or("missing application icon")?;
    let tray = TrayIconBuilder::new().icon(icon).tooltip("Tauritube").menu(&menu).show_menu_on_left_click(false).on_menu_event(|app, event| match event.id.as_ref() {
      "toggle" => if let Some(window) = app.get_webview_window("main") { if window.is_visible().unwrap_or(false) { window.hide().ok(); } else { window.show().ok(); window.set_focus().ok(); } },
      "quit" => app.exit(0),
      _ => {}
    }).on_tray_icon_event(|tray, event| {
      if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
        if let Some(window) = tray.app_handle().get_webview_window("main") { if window.is_visible().unwrap_or(false) { window.hide().ok(); } else { window.show().ok(); window.set_focus().ok(); } }
      }
    }).build(app)?;
    app.manage(TrayHandle(tray));
    let close_window = window.clone();
    window.on_window_event(move |event| { if let tauri::WindowEvent::CloseRequested { api, .. } = event { api.prevent_close(); close_window.hide().ok(); } });
    window.show()?;
    window.set_focus()?;
    let handle = app.handle().clone();
    tauri::async_runtime::spawn(async move {
      use tauri_plugin_updater::UpdaterExt;
      if let Ok(updater) = handle.updater() {
        if let Ok(Some(update)) = updater.check().await { let _ = handle.emit("update-available", update.version); }
      }
    });
    Ok(())
  }).manage(SearchState(Arc::new(Mutex::new(HashMap::new())))).plugin(tauri_plugin_updater::Builder::new().build()).invoke_handler(tauri::generate_handler![search_youtube, search_youtube_more, load_home, load_shorts, load_shorts_more, load_channel_videos, load_subscription_avatar, list_subscriptions, subscribe_channel, unsubscribe_channel, list_blocks, block_video, block_channel, unblock_item, minimize_window, hide_window, toggle_maximize, drag_window, set_input_lock, check_for_update, do_update]).run(tauri::generate_context!()).expect("error while running Tauritube");
}
