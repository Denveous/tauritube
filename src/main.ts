import { invoke } from '@tauri-apps/api/core'

const input = document.querySelector<HTMLInputElement>('#query')!
const stage = document.querySelector<HTMLElement>('#stage')!
const status = document.querySelector<HTMLElement>('#status')!
const chrome = document.querySelector<HTMLElement>('#chrome')!
chrome.setAttribute('data-tauri-drag-region', '')
let hideChromeTimer: number | undefined
let lastResults: SearchResult[] = []
let nextCursor: string | undefined
let loadingMore = false
let pages: SearchResult[][] = []
let pageIndex = 0
let playerInputLocked = false
let activeFrame: HTMLIFrameElement | undefined
let shortsResults: SearchResult[] = []
let shortIndex = 0
let shortWheelLocked = false
type BlockedItem = { kind: string, value: string, label?: string }
let blocked: BlockedItem[] = []
let activeShort: SearchResult | undefined
let blocking = false
const queue: SearchResult[] = []
const queueCount = document.querySelector<HTMLElement>('#queue-count')!
document.querySelector('#queue')!.replaceChildren('Queue:', queueCount)
const queuePanel = document.createElement('aside')
queuePanel.id = 'queue-panel'
document.querySelector('main')!.append(queuePanel)
const navPanel = document.createElement('aside')
navPanel.id = 'nav-panel'
document.querySelector('main')!.append(navPanel)
const navScrim = document.createElement('div')
navScrim.id = 'nav-scrim'
document.querySelector('main')!.append(navScrim)
const menu = document.createElement('button')
menu.id = 'menu'
menu.ariaLabel = 'Open navigation'
menu.textContent = '☰'
const brand = document.querySelector('#brand')!
brand.ariaLabel = 'Tauritube'
brand.querySelector('strong')!.textContent = 'Tauritube'
document.title = 'Tauritube'
brand.before(menu)
const playerDragZone = document.createElement('div')
playerDragZone.id = 'player-drag-zone'
document.querySelector('main')!.append(playerDragZone)
playerDragZone.addEventListener('mousedown', event => { if (event.button === 0) invoke('drag_window') })
const miniPlayer = document.createElement('section')
miniPlayer.id = 'mini-player'
document.querySelector('main')!.append(miniPlayer)
const miniRestore = document.createElement('button')
miniRestore.id = 'mini-restore'
miniRestore.ariaLabel = 'Return to player'
miniRestore.textContent = '↗'
document.querySelector('main')!.append(miniRestore)

type SearchResult = { id: string, title: string, channel: string, channel_id: string, duration: string, thumbnail: string }
type SearchPage = { results: SearchResult[], cursor?: string }
const historyKey = 'youtube-tauri-history'
let history: SearchResult[] = (() => { try { return JSON.parse(localStorage.getItem(historyKey) || '[]') } catch { return [] } })()

function remember(result?: SearchResult) {
  if (!result) return
  history = [result, ...history.filter(item => item.id !== result.id)].slice(0, 100)
  localStorage.setItem(historyKey, JSON.stringify(history))
}

const thumbnailCache = new Map<string, HTMLImageElement>()
async function preloadThumbnails(results: SearchResult[]) {
  await Promise.all(results.map(async result => {
    if (thumbnailCache.has(result.thumbnail)) return
    const image = new Image()
    await new Promise<void>(resolve => { image.onload = () => resolve(); image.onerror = () => resolve(); image.src = result.thumbnail })
    await image.decode?.().catch(() => {})
    thumbnailCache.set(result.thumbnail, image)
  }))
}

function embedUrl(value: string): string | null {
  let url: URL
  try { url = new URL(value.includes('://') ? value : `https://${value}`) } catch { return null }
  const host = url.hostname.replace(/^www\./, '')
  let video = ''
  if (host === 'youtu.be') video = url.pathname.slice(1)
  else if (host.endsWith('youtube.com')) video = url.searchParams.get('v') || (url.pathname.match(/^\/(?:embed|shorts|live)\/([^/?]+)/)?.[1] || '')
  if (!video && !url.searchParams.get('list')) return null
  const player = new URL(`https://www.youtube-nocookie.com/embed/${encodeURIComponent(video)}`)
  player.searchParams.set('autoplay', '1')
  player.searchParams.set('rel', '0')
  player.searchParams.set('modestbranding', '1')
  player.searchParams.set('playsinline', '1')
  player.searchParams.set('iv_load_policy', '3')
  const list = url.searchParams.get('list')
  if (list) player.searchParams.set('list', list)
  return player.toString()
}

function play(source: string, result?: SearchResult) {
  remember(result)
  miniPlayer.replaceChildren()
  const frame = document.createElement('iframe')
  frame.src = source
  frame.allow = 'autoplay; encrypted-media; fullscreen; picture-in-picture; clipboard-read; clipboard-write'
  frame.referrerPolicy = 'strict-origin-when-cross-origin'
  frame.title = 'YouTube player'
  frame.addEventListener('load', () => frame.contentWindow?.postMessage(JSON.stringify({ event: 'command', func: 'addEventListener', args: ['onStateChange'] }), '*'))
  activeFrame = frame
  stage.replaceChildren(frame)
  document.body.classList.remove('browsing', 'mini-playing')
  document.body.classList.add('playing', 'chrome-visible')
  status.textContent = ''
  hideChromeSoon()
}

function miniaturize() {
  if (!activeFrame) return
  miniPlayer.append(activeFrame)
  activeFrame.contentWindow?.postMessage({ source: 'tauritube', action: 'mini-state', mini: true }, '*')
  document.body.classList.remove('playing', 'chrome-visible')
  document.body.classList.add('browsing', 'mini-playing')
  if (lastResults.length) { showResults(lastResults); status.textContent = `${lastResults.length} results` }
  else { stage.replaceChildren(); status.textContent = '' }
}

function restoreMiniPlayer() {
  if (!activeFrame || !document.body.classList.contains('mini-playing')) return
  stage.replaceChildren(activeFrame)
  miniPlayer.replaceChildren()
  document.body.classList.remove('browsing', 'mini-playing')
  document.body.classList.add('playing', 'chrome-visible')
  activeFrame.contentWindow?.postMessage({ source: 'tauritube', action: 'mini-state', mini: false }, '*')
  hideChromeSoon()
}

function updatePagination() {
  const previous = document.querySelector<HTMLButtonElement>('#prev-page')!
  const next = document.querySelector<HTMLButtonElement>('#next-page')!
  previous.disabled = pageIndex <= 0
  next.disabled = !nextCursor && pageIndex >= pages.length - 1
}

function isBlocked(result: SearchResult) { return blocked.some(item => item.kind === 'video' && item.value === result.id || item.kind === 'channel' && (item.value === result.channel_id || item.value.toLowerCase() === result.channel.toLowerCase())) }

async function blockCurrent(kind: 'video' | 'channel', videoId: string, channel: string, channelId: string) {
  if (blocking) return
  blocking = true
  try {
    if (kind === 'video') { await invoke('block_video', { id: videoId }); if (!blocked.some(item => item.kind === kind && item.value === videoId)) blocked.push({ kind, value: videoId, label: activeShort?.title || videoId }) }
    else { if (!channel && !channelId) return; await invoke('block_channel', { channel, channelId }); const value = channelId || channel; if (!blocked.some(item => item.kind === kind && (item.value === value || item.label?.toLowerCase() === channel.toLowerCase()))) blocked.push({ kind, value, label: channel }) }
    await loadShorts()
  } finally { blocking = false }
}

function showResults(results: SearchResult[], historyView = false, homeView = false) {
  results = results.filter(result => !isBlocked(result))
  lastResults = results
  const list = document.createElement('div')
  list.id = 'results'
  if (homeView) {
    const categories = document.createElement('nav')
    categories.id = 'home-categories'
    for (const [label, query] of [['Trending', 'trending videos'], ['Live now', 'live streams'], ['Music', 'music'], ['Gaming', 'gaming'], ['Relaxing', 'relaxing music'], ['Learning', 'educational videos']]) {
      const button = document.createElement('button')
      button.textContent = label
      button.addEventListener('click', () => searchFor(query))
      categories.append(button)
    }
    list.append(categories)
  }
  for (const result of results) {
    const card = document.createElement('div')
    card.className = 'result'
    card.tabIndex = 0
    const image = thumbnailCache.get(result.thumbnail)?.cloneNode() as HTMLImageElement || document.createElement('img')
    image.src = result.thumbnail
    image.alt = ''
    image.loading = 'eager'
    image.decoding = 'async'
    image.setAttribute('fetchpriority', 'low')
    const details = document.createElement('span')
    const title = document.createElement('b')
    title.textContent = result.title
    const meta = document.createElement('small')
    meta.textContent = `${result.channel}${result.duration ? ` · ${result.duration}` : ''}`
    details.append(title, meta)
    card.append(image, details)
    card.addEventListener('click', () => play(`https://www.youtube-nocookie.com/embed/${encodeURIComponent(result.id)}?autoplay=1&rel=0&modestbranding=1&playsinline=1&iv_load_policy=3&enablejsapi=1&origin=${encodeURIComponent(location.origin)}`, result))
    const add = document.createElement('button')
    add.className = 'result-add'
    add.textContent = '+ Queue'
    add.addEventListener('click', event => { event.stopPropagation(); queue.push(result); renderQueue() })
    const subscribe = document.createElement('button')
    subscribe.className = 'result-subscribe'
    subscribe.textContent = 'Subscribe'
    subscribe.addEventListener('click', async event => { event.stopPropagation(); await invoke('subscribe_channel', { channel: result.channel, channelId: result.channel_id }); renderNavigation() })
    const blockVideo = document.createElement('button')
    blockVideo.className = 'result-block-video'
    blockVideo.textContent = 'Block video'
    blockVideo.addEventListener('click', async event => { event.stopPropagation(); await invoke('block_video', { id: result.id }); blocked.push({ kind: 'video', value: result.id }); showResults(lastResults, historyView, homeView) })
    const blockChannel = document.createElement('button')
    blockChannel.className = 'result-block-channel'
    blockChannel.textContent = 'Block channel'
    blockChannel.disabled = !result.channel && !result.channel_id
    blockChannel.addEventListener('click', async event => { event.stopPropagation(); await invoke('block_channel', { channel: result.channel, channelId: result.channel_id }); blocked.push({ kind: 'channel', value: result.channel_id || result.channel }); showResults(lastResults, historyView, homeView) })
    card.append(add, subscribe, blockVideo, blockChannel)
    if (historyView) {
      const remove = document.createElement('button')
      remove.className = 'result-remove'
      remove.textContent = '×'
      remove.ariaLabel = 'Remove from history'
      remove.addEventListener('click', event => { event.stopPropagation(); history = history.filter(item => item.id !== result.id); localStorage.setItem(historyKey, JSON.stringify(history)); if (history.length) showResults(history, true); else { stage.replaceChildren(); status.textContent = 'No history yet' } })
      card.append(remove)
    }
    list.append(card)
  }
  stage.replaceChildren(list)
  stage.scrollTop = 0
  updatePagination()
}

function showShorts(results: SearchResult[], index = 0) {
  shortsResults = results
  shortIndex = (index + results.length) % results.length
  const result = results[shortIndex]
  activeShort = result
  const viewer = document.createElement('section')
  viewer.id = 'shorts-viewer'
  const frame = document.createElement('iframe')
  frame.id = 'shorts-player'
  frame.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(result.id)}?autoplay=1&rel=0&modestbranding=1&playsinline=1&iv_load_policy=3&enablejsapi=1&tauritube_shorts=1&origin=${encodeURIComponent(location.origin)}`
  frame.allow = 'autoplay; encrypted-media; fullscreen; picture-in-picture; clipboard-read; clipboard-write'
  frame.referrerPolicy = 'strict-origin-when-cross-origin'
  frame.title = result.title || 'YouTube Short'
  const details = document.createElement('div')
  details.id = 'shorts-details'
  details.textContent = result.title || 'YouTube Short'
  viewer.append(frame, details)
  stage.replaceChildren(viewer)
  stage.scrollTop = 0
  status.textContent = `Short ${shortIndex + 1} / ${results.length}`
}

function renderQueue() {
  queueCount.textContent = String(queue.length)
  queuePanel.replaceChildren()
  if (!queuePanel.classList.contains('open')) return
  const title = document.createElement('header')
  title.textContent = queue.length ? `Queue · ${queue.length}` : 'Queue is empty'
  const clear = document.createElement('button')
  clear.textContent = 'Clear'
  clear.disabled = !queue.length
  clear.addEventListener('click', () => { queue.splice(0); renderQueue() })
  title.append(clear)
  queuePanel.append(title)
  for (const [index, result] of queue.entries()) {
    const row = document.createElement('div')
    row.className = 'queue-item'
    const label = document.createElement('span')
    label.textContent = result.title
    const remove = document.createElement('button')
    remove.textContent = '×'
    remove.addEventListener('click', () => { queue.splice(index, 1); renderQueue() })
    row.append(label, remove)
    queuePanel.append(row)
  }
}

function showBlocked() {
  const list = document.createElement('section')
  list.id = 'block-list'
  const title = document.createElement('h2')
  title.textContent = 'Blocked'
  list.append(title)
  if (!blocked.length) { const empty = document.createElement('p'); empty.textContent = 'No blocked videos or channels.'; list.append(empty) }
  for (const item of blocked) {
    const row = document.createElement('div')
    const label = document.createElement('span')
    label.textContent = `${item.kind === 'channel' ? 'Channel' : 'Video'}: ${item.label || item.value}`
    const remove = document.createElement('button')
    remove.textContent = 'Unblock'
    remove.addEventListener('click', async () => { await invoke('unblock_item', item); blocked = blocked.filter(block => block.kind !== item.kind || block.value !== item.value); showBlocked() })
    row.append(label, remove)
    list.append(row)
  }
  stage.replaceChildren(list)
  status.textContent = 'Blocked'
}

async function renderNavigation() {
  navPanel.replaceChildren()
  const action = (label: string, icon: string, handler: () => void) => { const button = document.createElement('button'); button.className = 'nav-action'; button.innerHTML = `<span aria-hidden="true">${icon}</span>${label}`; button.addEventListener('click', handler); return button }
  const closeNavigation = () => { navPanel.classList.remove('open'); navScrim.classList.remove('open') }
  const home = action('Home', '⌂', () => { closeNavigation(); loadHome() })
  const shorts = action('Shorts', '▷', () => { closeNavigation(); loadShorts() })
  const historyButton = action('History', '↶', () => {
    closeNavigation()
    if (!history.length) { stage.replaceChildren(); status.textContent = 'No history yet'; return }
    showResults(history, true)
    status.textContent = 'History'
  })
  const blockedButton = action('Blocked', '⊘', () => { closeNavigation(); showBlocked() })
  const library = document.createElement('b')
  library.textContent = 'You'
  const heading = document.createElement('b')
  heading.textContent = 'Subscriptions'
  navPanel.append(home, shorts, library, historyButton, blockedButton, heading)
  try {
    const subscriptions = await invoke<{ channel: string, channel_id: string }[]>('list_subscriptions')
    for (const item of subscriptions) {
      const row = document.createElement('div')
      row.className = 'subscription'
      const channel = document.createElement('button')
      channel.textContent = item.channel
      channel.addEventListener('click', () => { closeNavigation(); loadChannelVideos(item) })
      const remove = document.createElement('button')
      remove.textContent = '×'
      remove.addEventListener('click', async () => { await invoke('unsubscribe_channel', { channel: item.channel }); renderNavigation() })
      row.append(channel, remove)
      navPanel.append(row)
    }
  } catch {}
}

function playNext() { const next = queue.shift(); if (next) { renderQueue(); play(`https://www.youtube-nocookie.com/embed/${encodeURIComponent(next.id)}?autoplay=1&rel=0&modestbranding=1&playsinline=1&iv_load_policy=3&enablejsapi=1&origin=${encodeURIComponent(location.origin)}`, next) } }

async function loadMore() {
  if (!nextCursor || loadingMore) return
  loadingMore = true
  try {
    const page = await invoke<SearchPage>('search_youtube_more', { cursor: nextCursor })
    nextCursor = page.cursor
    await preloadThumbnails(page.results)
    pages.push(page.results)
    pageIndex = pages.length - 1
    showResults(page.results)
    status.textContent = `${pageIndex + 1}`
  } catch (error) { status.textContent = String(error); nextCursor = undefined }
  finally { loadingMore = false; updatePagination() }
}

async function showFeed(command: string, args: Record<string, string>, label: string) {
  document.body.classList.remove('playing', 'chrome-visible')
  document.body.classList.add('browsing')
  status.textContent = ''
  if (label === 'Home') showResults([], false, true)
  try {
    const page = await invoke<SearchPage>(command, args)
    nextCursor = undefined
    if (!page.results.length) { if (label === 'Home') showResults([], false, true); else stage.replaceChildren(); status.textContent = `No ${label.toLowerCase()} found`; return }
    await preloadThumbnails(page.results)
    pages = [page.results]
    pageIndex = 0
    showResults(page.results, false, label === 'Home')
    status.textContent = label
    updatePagination()
  } catch (error) { status.textContent = String(error) }
}

async function loadShorts() {
  document.body.classList.remove('playing', 'chrome-visible')
  document.body.classList.add('browsing')
  status.textContent = ''
  try {
    const page = await invoke<SearchPage>('load_shorts')
    if (!page.results.length) { stage.replaceChildren(); status.textContent = 'No shorts found'; return }
    showShorts(page.results)
  } catch (error) { status.textContent = String(error) }
}
function loadHome() { showFeed('load_home', {}, 'Home') }
function loadChannelVideos(subscription: { channel: string, channel_id: string }) { showFeed('load_channel_videos', { channel: subscription.channel, channelId: subscription.channel_id || '' }, subscription.channel) }

async function go() {
  const value = input.value.trim()
  if (!value) return
  searchFor(value)
}

async function searchFor(value: string) {
  input.value = value
  const source = embedUrl(value)
  if (source) { play(source); return }
  document.body.classList.remove('playing', 'chrome-visible')
  document.body.classList.add('browsing')
  status.textContent = ''
  try {
    const page = await invoke<SearchPage>('search_youtube', { query: value })
    nextCursor = page.cursor
    if (!page.results.length) { status.textContent = 'No videos found'; return }
    await preloadThumbnails(page.results)
    pages = [page.results]
    pageIndex = 0
    showResults(page.results)
    status.textContent = '1'
    updatePagination()
  } catch (error) { status.textContent = String(error) }
}

document.querySelector('#go')!.addEventListener('click', go)
brand.addEventListener('click', loadHome)
input.addEventListener('keydown', event => { if (event.key === 'Enter') go() })
document.querySelector('#clear')!.addEventListener('click', () => { input.value = ''; nextCursor = undefined; lastResults = []; pages = []; pageIndex = 0; stage.replaceChildren(); status.textContent = ''; input.focus() })
document.querySelector('#queue')!.addEventListener('click', () => { queuePanel.classList.toggle('open'); renderQueue() })
miniRestore.addEventListener('click', restoreMiniPlayer)
menu.addEventListener('click', () => { const opening = !navPanel.classList.contains('open'); navPanel.classList.toggle('open', opening); navScrim.classList.toggle('open', opening); if (opening) renderNavigation() })
navScrim.addEventListener('click', () => { navPanel.classList.remove('open'); navScrim.classList.remove('open') })
document.querySelector('#prev-page')!.addEventListener('click', async () => { if (pageIndex > 0) { pageIndex--; await preloadThumbnails(pages[pageIndex]); showResults(pages[pageIndex]); status.textContent = `${pageIndex + 1}` } updatePagination() })
document.querySelector('#next-page')!.addEventListener('click', async () => { if (pageIndex + 1 < pages.length) { pageIndex++; await preloadThumbnails(pages[pageIndex]); showResults(pages[pageIndex]); status.textContent = `${pageIndex + 1}` } else await loadMore(); updatePagination() })
document.querySelector('#minimize')!.addEventListener('click', () => invoke('minimize_window'))
document.querySelector('#close')!.addEventListener('click', () => invoke('hide_window'))
document.querySelector('#back')!.addEventListener('click', () => {
  document.body.classList.remove('playing', 'chrome-visible')
  document.body.classList.add('browsing')
  if (lastResults.length) { showResults(lastResults); status.textContent = `${lastResults.length} results` }
  else { stage.replaceChildren(); status.textContent = '' }
})
stage.addEventListener('wheel', event => {
  if (!shortsResults.length || !stage.querySelector('#shorts-viewer') || shortWheelLocked || Math.abs(event.deltaY) < 20) return
  event.preventDefault()
  shortWheelLocked = true
  showShorts(shortsResults, shortIndex + (event.deltaY > 0 ? 1 : -1))
  window.setTimeout(() => { shortWheelLocked = false }, 220)
}, { passive: false })
chrome.addEventListener('dblclick', event => {
  if ((event.target as HTMLElement).closest('input, button')) return
  invoke('toggle_maximize')
})

function hideChromeSoon() {
  window.clearTimeout(hideChromeTimer)
  hideChromeTimer = window.setTimeout(() => {
    if (document.activeElement !== input) document.body.classList.remove('chrome-visible')
  }, 1800)
}

function revealChrome() {
  if (!document.body.classList.contains('playing')) return
  window.clearTimeout(hideChromeTimer)
  document.body.classList.add('chrome-visible')
}

document.querySelector('#reveal-zone')!.addEventListener('mouseenter', revealChrome)
chrome.addEventListener('mouseenter', revealChrome)
chrome.addEventListener('mouseleave', hideChromeSoon)
input.addEventListener('focus', revealChrome)
input.addEventListener('blur', hideChromeSoon)
window.addEventListener('message', event => {
  const playerBridge = event.data?.source === 'tauritube' || event.data?.source === 'youtube-tauri'
  if (playerBridge && event.data?.action === 'back') { document.querySelector<HTMLButtonElement>('#back')!.click(); return }
  if (playerBridge && event.data?.action === 'drag') { invoke('drag_window'); return }
  if (playerBridge && event.data?.action === 'mini') { miniaturize(); return }
  if (playerBridge && event.data?.action === 'short-info') { const current = activeShort; if (!current || current.id !== event.data.videoId) return; current.channel = event.data.channel || current.channel; current.channel_id = event.data.channelId || current.channel_id; return }
  if (playerBridge && event.data?.action === 'block-video') { const id = event.data.videoId || activeShort?.id; if (id) void blockCurrent('video', id, '', ''); return }
  if (playerBridge && event.data?.action === 'block-channel') { void blockCurrent('channel', '', event.data.channel || activeShort?.channel || '', event.data.channelId || activeShort?.channel_id || ''); return }
  if (playerBridge && event.data?.action === 'input-lock') { playerInputLocked = Boolean(event.data.locked); invoke('set_input_lock', { locked: playerInputLocked }); return }
  if (event.origin !== 'https://www.youtube-nocookie.com') return
  try { const message = typeof event.data === 'string' ? JSON.parse(event.data) : event.data; if (message?.event === 'onStateChange' && message.info === 0) playNext() } catch {}
})
window.addEventListener('blur', () => { if (playerInputLocked) invoke('set_input_lock', { locked: false }) })
window.addEventListener('focus', () => { if (playerInputLocked) invoke('set_input_lock', { locked: true }) })
async function start() { try { blocked = await invoke<BlockedItem[]>('list_blocks') } catch {} loadHome() }
start()
