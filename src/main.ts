import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

const input = document.querySelector<HTMLInputElement>('#query')!
const clearButton = document.querySelector<HTMLButtonElement>('#clear')!
const searchField = document.createElement('label')
searchField.id = 'search-field'
const searchIcon = document.createElement('span')
searchIcon.id = 'search-icon'
searchIcon.ariaHidden = 'true'
const searchSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
searchSvg.setAttribute('viewBox', '0 0 24 24')
searchSvg.setAttribute('aria-hidden', 'true')
const searchPath = document.createElementNS('http://www.w3.org/2000/svg', 'path')
searchPath.setAttribute('d', 'M11 2a9 9 0 105.641 16.01.966.966 0 00.152.197l3.5 3.5a1 1 0 101.414-1.414l-3.5-3.5a1 1 0 00-.197-.153A8.96 8.96 0 0020 11a9 9 0 00-9-9Zm0 2a7 7 0 110 14 7 7 0 010-14Z')
searchSvg.append(searchPath)
searchIcon.append(searchSvg)
const goButton = document.querySelector<HTMLButtonElement>('#go')!
goButton.ariaLabel = 'Search'
goButton.replaceChildren(searchSvg.cloneNode(true))
input.before(searchField)
searchField.append(searchIcon, input, clearButton)
function updateClearButton() { clearButton.hidden = !input.value }
input.addEventListener('input', updateClearButton)
updateClearButton()
const stage = document.querySelector<HTMLElement>('#stage')!
const status = document.querySelector<HTMLElement>('#status')!
const chrome = document.querySelector<HTMLElement>('#chrome')!
chrome.setAttribute('data-tauri-drag-region', '')
const sidebarPlayerStyle = document.createElement('style')
sidebarPlayerStyle.textContent = '.playing main:has(#nav-panel.open) #chrome{display:flex!important;transform:none;opacity:1;pointer-events:auto}.playing main:has(#nav-panel.open) #stage,body.browsing main:has(#nav-panel.open) #stage{position:absolute;inset:64px 0 0 282px;width:auto;height:auto;margin:0}'
document.head.append(sidebarPlayerStyle)
const subscriptionRemovalStyle = document.createElement('style')
subscriptionRemovalStyle.textContent = '#nav-panel .subscription.confirming{grid-template-columns:30px minmax(0,1fr) auto auto!important}#nav-panel .subscription-confirm{background:#832222!important;color:#fff}'
document.head.append(subscriptionRemovalStyle)
let hideChromeTimer: number | undefined
let lastResults: SearchResult[] = []
let nextCursor: string | undefined
let loadingMore = false
let pages: SearchResult[][] = []
let pageIndex = 0
let playerInputLocked = false
let activeFrame: HTMLIFrameElement | undefined
let activeResult: SearchResult | undefined
let shortsResults: SearchResult[] = []
let shortIndex = 0
let shortWheelLocked = false
let shortsLoadingMore = false
let homeLoadId = 0
let historySelection = new Set<string>()
type BlockedItem = { kind: string, value: string, label?: string, thumbnail?: string }
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
navPanel.addEventListener('click', event => { if ((event.target as HTMLElement).closest('.nav-action')) pushCurrentView() }, true)
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
const updateButton = document.createElement('button')
updateButton.id = 'update'
updateButton.ariaLabel = 'Install update'
updateButton.title = 'Install update'
const updateIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
updateIcon.setAttribute('viewBox', '0 0 24 24')
updateIcon.setAttribute('aria-hidden', 'true')
const updatePath = document.createElementNS('http://www.w3.org/2000/svg', 'path')
updatePath.setAttribute('d', 'M19 9h-4V3H9v6H5l7 7 7-7zm-14 9v2h14v-2z')
updateIcon.append(updatePath)
updateButton.append(updateIcon)
updateButton.disabled = true
brand.after(updateButton)
function showUpdate(version: string) { updateButton.disabled = false; updateButton.title = `Install update ${version}` }
updateButton.addEventListener('click', async () => { updateButton.disabled = true; updateButton.title = 'Installing update'; try { await invoke('do_update') } catch (error) { updateButton.disabled = false; updateButton.title = 'Update failed'; status.textContent = String(error) } })
void listen<string>('update-available', event => showUpdate(event.payload))
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
type PlaylistTrack = { query: string, result?: SearchResult, candidates?: SearchResult[] }
type Playlist = { name: string, tracks: PlaylistTrack[] }
const historyKey = 'youtube-tauri-history'
let history: SearchResult[] = (() => { try { return JSON.parse(localStorage.getItem(historyKey) || '[]') } catch { return [] } })()
let currentView: (() => void) | undefined
const previousViews: (() => void)[] = []
const nextViews: (() => void)[] = []

function setCurrentView(view: () => void) { currentView = view; updatePagination() }
function pushCurrentView() { if (!currentView) return; previousViews.push(currentView); nextViews.splice(0); updatePagination() }
function goToPreviousView() { const view = previousViews.pop(); if (!view || !currentView) return; nextViews.push(currentView); view(); updatePagination() }
function goToNextView() { const view = nextViews.pop(); if (!view || !currentView) return; previousViews.push(currentView); view(); updatePagination() }
const playlistsKey = 'youtube-tauri-playlists'
let playlists: Playlist[] = (() => { try { const value = JSON.parse(localStorage.getItem(playlistsKey) || '[]'); return Array.isArray(value) ? value.filter(item => typeof item?.name === 'string' && Array.isArray(item.tracks)).map(item => ({ name: item.name, tracks: item.tracks.filter((track: PlaylistTrack) => typeof track?.query === 'string').map((track: PlaylistTrack) => ({ query: track.query, result: track.result })) })) : [] } catch { return [] } })()

function savePlaylists() { localStorage.setItem(playlistsKey, JSON.stringify(playlists.map(playlist => ({ name: playlist.name, tracks: playlist.tracks.map(track => ({ query: track.query, result: track.result })) })))) }

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
  activeResult = result
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

function miniaturize(time?: number) {
  if (!activeFrame) return
  if (time && time > 0) { const source = new URL(activeFrame.src); source.searchParams.set('start', String(Math.floor(time))); activeFrame.src = source.toString() }
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
  previous.disabled = !previousViews.length
  next.disabled = !nextViews.length
}

function isBlocked(result: SearchResult) { return blocked.some(item => item.kind === 'video' && item.value === result.id || item.kind === 'channel' && (item.value === result.channel_id || item.value.toLowerCase() === result.channel.toLowerCase() || item.label?.toLowerCase() === result.channel.toLowerCase())) }
function isShort(result: SearchResult) { return result.title === 'YouTube Short' }

async function blockCurrent(kind: 'video' | 'channel', videoId: string, channel: string, channelId: string) {
  if (blocking) return
  blocking = true
  try {
    const current = activeShort || activeResult
    if (kind === 'video') { await invoke('block_video', { id: videoId, label: current?.title, thumbnail: current?.thumbnail }); if (!blocked.some(item => item.kind === kind && item.value === videoId)) blocked.push({ kind, value: videoId, label: current?.title || videoId, thumbnail: current?.thumbnail }) }
    else { if (!channel && !channelId) return; await invoke('block_channel', { channel, channelId, thumbnail: current?.thumbnail }); const value = channelId || channel; if (!blocked.some(item => item.kind === kind && (item.value === value || item.label?.toLowerCase() === channel.toLowerCase()))) blocked.push({ kind, value, label: channel, thumbnail: current?.thumbnail }) }
    await loadShorts()
  } finally { blocking = false }
}

function showResults(results: SearchResult[], historyView = false, homeView = false) {
  results = results.filter(result => !isBlocked(result) && (!homeView || !isShort(result)))
  lastResults = results
  setCurrentView(() => showResults(results, historyView, homeView))
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
  if (historyView) {
    const tools = document.createElement('nav')
    tools.id = 'history-tools'
    const selectAll = document.createElement('button')
    selectAll.textContent = historySelection.size === results.length && results.length ? 'Clear selection' : 'Select all'
    selectAll.addEventListener('click', () => { historySelection = historySelection.size === results.length ? new Set() : new Set(results.map(result => result.id)); showResults(history, true); status.textContent = 'History' })
    const removeSelected = document.createElement('button')
    removeSelected.textContent = `Delete selected${historySelection.size ? ` (${historySelection.size})` : ''}`
    removeSelected.disabled = !historySelection.size
    removeSelected.addEventListener('click', () => { history = history.filter(result => !historySelection.has(result.id)); historySelection.clear(); localStorage.setItem(historyKey, JSON.stringify(history)); showResults(history, true); status.textContent = history.length ? 'History' : 'No history yet' })
    const purge = document.createElement('button')
    purge.textContent = 'Clear all history'
    purge.addEventListener('click', () => { history = []; historySelection.clear(); localStorage.removeItem(historyKey); showResults(history, true); status.textContent = 'No history yet' })
    tools.append(selectAll, removeSelected, purge)
    list.append(tools)
  }
  for (const result of results) {
    const card = document.createElement('div')
    card.className = 'result'
    if (historyView && historySelection.has(result.id)) card.classList.add('selected')
    card.tabIndex = 0
    const image = thumbnailCache.get(result.thumbnail)?.cloneNode() as HTMLImageElement || document.createElement('img')
    image.src = result.thumbnail
    image.alt = ''
    image.draggable = false
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
    const actions = document.createElement('div')
    actions.className = 'result-actions'
    const add = document.createElement('button')
    add.className = 'result-add'
    add.textContent = '＋'
    add.ariaLabel = 'Add to queue'
    add.title = 'Add to queue'
    add.addEventListener('click', event => { event.stopPropagation(); queue.push(result); renderQueue() })
    const subscribe = document.createElement('button')
    subscribe.className = 'result-subscribe'
    subscribe.textContent = '☆'
    subscribe.ariaLabel = 'Subscribe to channel'
    subscribe.title = 'Subscribe to channel'
    subscribe.addEventListener('click', async event => { event.stopPropagation(); await invoke('subscribe_channel', { channel: result.channel, channelId: result.channel_id }); renderNavigation() })
    const block = document.createElement('button')
    block.className = 'result-block'
    block.textContent = '⊘'
    block.ariaLabel = 'Block options'
    block.title = 'Block options'
    const blockMenu = document.createElement('div')
    blockMenu.className = 'result-block-menu'
    const blockVideo = document.createElement('button')
    blockVideo.textContent = 'Block video'
    blockVideo.addEventListener('click', async event => { event.stopPropagation(); await invoke('block_video', { id: result.id, label: result.title, thumbnail: result.thumbnail }); blocked.push({ kind: 'video', value: result.id, label: result.title, thumbnail: result.thumbnail }); showResults(lastResults, historyView, homeView) })
    const blockChannel = document.createElement('button')
    blockChannel.textContent = 'Block channel'
    blockChannel.disabled = !result.channel && !result.channel_id
    blockChannel.addEventListener('click', async event => { event.stopPropagation(); await invoke('block_channel', { channel: result.channel, channelId: result.channel_id, thumbnail: result.thumbnail }); blocked.push({ kind: 'channel', value: result.channel_id || result.channel, label: result.channel, thumbnail: result.thumbnail }); if (homeView) await loadHome(); else showResults(lastResults, historyView, homeView) })
    block.addEventListener('click', event => { event.stopPropagation(); blockMenu.classList.toggle('open') })
    blockMenu.append(blockVideo, blockChannel)
    actions.append(add, subscribe, block, blockMenu)
    card.append(actions)
    if (historyView) {
      const select = document.createElement('input')
      select.className = 'result-select'
      select.type = 'checkbox'
      select.checked = historySelection.has(result.id)
      select.ariaLabel = `Select ${result.title}`
      select.addEventListener('click', event => event.stopPropagation())
      select.addEventListener('change', () => { if (select.checked) historySelection.add(result.id); else historySelection.delete(result.id); showResults(history, true); status.textContent = 'History' })
      const remove = document.createElement('button')
      remove.className = 'result-remove'
      remove.textContent = '×'
      remove.ariaLabel = 'Remove from history'
      remove.addEventListener('click', event => { event.stopPropagation(); historySelection.delete(result.id); history = history.filter(item => item.id !== result.id); localStorage.setItem(historyKey, JSON.stringify(history)); showResults(history, true); status.textContent = history.length ? 'History' : 'No history yet' })
      card.append(select, remove)
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
  setCurrentView(() => showShorts(results, shortIndex))
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
  if (shortIndex >= results.length - 2) void loadMoreShorts(result.id)
}

async function loadMoreShorts(videoId: string) {
  if (shortsLoadingMore) return
  shortsLoadingMore = true
  try {
    const page = await invoke<SearchPage>('load_shorts_more', { videoId })
    const existing = new Set(shortsResults.map(result => result.id))
    shortsResults.push(...page.results.filter(result => !existing.has(result.id)))
  } catch { } finally { shortsLoadingMore = false }
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

function downloadPlaylist(playlist: Playlist) {
  const text = playlist.tracks.map(track => track.query.trim()).filter(Boolean).join('\r\n')
  if (!text) { status.textContent = 'Playlist is empty'; return }
  const file = new Blob([text], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(file)
  const link = document.createElement('a')
  link.href = url
  link.download = `${(playlist.name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim() || 'playlist')}.txt`
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  status.textContent = `Exported ${playlist.tracks.length} tracks`
}

function playPlaylist(playlist: Playlist) {
  const tracks = playlist.tracks.map(track => track.result).filter((result): result is SearchResult => Boolean(result))
  if (!tracks.length) { status.textContent = 'Find matches before playing this playlist'; return }
  queue.splice(0, queue.length, ...tracks.slice(1))
  renderQueue()
  play(`https://www.youtube-nocookie.com/embed/${encodeURIComponent(tracks[0].id)}?autoplay=1&rel=0&modestbranding=1&playsinline=1&iv_load_policy=3&enablejsapi=1&origin=${encodeURIComponent(location.origin)}`, tracks[0])
}

async function resolvePlaylistTrack(playlist: Playlist, track: PlaylistTrack) {
  const query = track.query.trim()
  if (!query) return
  status.textContent = `Finding ${query}`
  try {
    const page = await invoke<SearchPage>('search_youtube', { query })
    track.candidates = page.results.slice(0, 5)
    track.result = track.candidates[0]
    if (track.candidates.length) await preloadThumbnails(track.candidates)
    savePlaylists()
  } catch (error) { status.textContent = String(error) }
}

function showPlaylistEditor(index: number) {
  setCurrentView(() => showPlaylistEditor(index))
  const playlist = playlists[index]
  if (!playlist) return showPlaylists()
  const view = document.createElement('section')
  view.id = 'playlist-editor'
  const header = document.createElement('header')
  const name = document.createElement('input')
  name.value = playlist.name
  name.ariaLabel = 'Playlist name'
  name.addEventListener('change', () => { playlist.name = name.value.trim() || 'Untitled playlist'; name.value = playlist.name; savePlaylists() })
  const back = document.createElement('button')
  back.textContent = 'Back to playlists'
  back.addEventListener('click', showPlaylists)
  header.append(name, back)
  const tools = document.createElement('div')
  tools.className = 'playlist-tools'
  const add = document.createElement('button')
  add.textContent = 'Add track'
  add.addEventListener('click', () => { playlist.tracks.push({ query: '' }); savePlaylists(); showPlaylistEditor(index) })
  const exportButton = document.createElement('button')
  exportButton.textContent = 'Export text list'
  exportButton.addEventListener('click', () => downloadPlaylist(playlist))
  const playButton = document.createElement('button')
  playButton.textContent = 'Play playlist'
  playButton.addEventListener('click', () => playPlaylist(playlist))
  tools.append(add, exportButton, playButton)
  const list = document.createElement('div')
  list.className = 'playlist-track-list'
  if (!playlist.tracks.length) {
    const empty = document.createElement('p')
    empty.textContent = 'Paste a text list into a new playlist, or add tracks here.'
    list.append(empty)
  }
  playlist.tracks.forEach((track, trackIndex) => {
    const row = document.createElement('article')
    row.className = 'playlist-track'
    const number = document.createElement('b')
    number.textContent = String(trackIndex + 1)
    const details = document.createElement('div')
    const query = document.createElement('input')
    query.value = track.query
    query.placeholder = 'Artist - Title'
    query.addEventListener('change', () => { track.query = query.value.trim(); track.result = undefined; track.candidates = undefined; savePlaylists(); showPlaylistEditor(index) })
    const match = document.createElement('small')
    match.textContent = track.result ? `${track.result.title}${track.result.channel ? ` — ${track.result.channel}` : ''}` : 'No YouTube match selected'
    details.append(query, match)
    if (track.candidates?.length) {
      const choices = document.createElement('div')
      choices.className = 'playlist-match-choices'
      for (const candidate of track.candidates) {
        const choice = document.createElement('button')
        choice.textContent = `${candidate.title}${candidate.channel ? ` — ${candidate.channel}` : ''}`
        choice.classList.toggle('selected', candidate.id === track.result?.id)
        choice.addEventListener('click', () => { track.result = candidate; savePlaylists(); showPlaylistEditor(index) })
        choices.append(choice)
      }
      details.append(choices)
    }
    const actions = document.createElement('div')
    actions.className = 'playlist-track-actions'
    const find = document.createElement('button')
    find.textContent = 'Find match'
    find.addEventListener('click', async () => { await resolvePlaylistTrack(playlist, track); showPlaylistEditor(index); status.textContent = track.result ? `Matched ${track.result.title}` : `No match for ${track.query}` })
    const playButton = document.createElement('button')
    playButton.textContent = 'Play'
    playButton.disabled = !track.result
    playButton.addEventListener('click', () => { if (track.result) play(`https://www.youtube-nocookie.com/embed/${encodeURIComponent(track.result.id)}?autoplay=1&rel=0&modestbranding=1&playsinline=1&iv_load_policy=3&enablejsapi=1&origin=${encodeURIComponent(location.origin)}`, track.result) })
    const up = document.createElement('button')
    up.textContent = '↑'
    up.disabled = trackIndex === 0
    up.addEventListener('click', () => { [playlist.tracks[trackIndex - 1], playlist.tracks[trackIndex]] = [playlist.tracks[trackIndex], playlist.tracks[trackIndex - 1]]; savePlaylists(); showPlaylistEditor(index) })
    const down = document.createElement('button')
    down.textContent = '↓'
    down.disabled = trackIndex === playlist.tracks.length - 1
    down.addEventListener('click', () => { [playlist.tracks[trackIndex], playlist.tracks[trackIndex + 1]] = [playlist.tracks[trackIndex + 1], playlist.tracks[trackIndex]]; savePlaylists(); showPlaylistEditor(index) })
    const remove = document.createElement('button')
    remove.textContent = 'Remove'
    remove.addEventListener('click', () => { playlist.tracks.splice(trackIndex, 1); savePlaylists(); showPlaylistEditor(index) })
    actions.append(find, playButton, up, down, remove)
    row.append(number, details, actions)
    list.append(row)
  })
  view.append(header, tools, list)
  stage.replaceChildren(view)
  stage.scrollTop = 0
  status.textContent = `${playlist.tracks.length} tracks`
}

function showPlaylistImport() {
  setCurrentView(showPlaylistImport)
  const view = document.createElement('section')
  view.id = 'playlist-import'
  const heading = document.createElement('h2')
  heading.textContent = 'Import text playlist'
  const name = document.createElement('input')
  name.placeholder = 'Playlist name'
  name.value = 'Imported playlist'
  const text = document.createElement('textarea')
  text.placeholder = 'Artist - Title\nArtist - Title'
  const actions = document.createElement('div')
  const importButton = document.createElement('button')
  importButton.textContent = 'Import playlist'
  const back = document.createElement('button')
  back.textContent = 'Cancel'
  back.addEventListener('click', showPlaylists)
  importButton.addEventListener('click', async () => {
    const tracks = text.value.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(query => ({ query }))
    if (!tracks.length) { status.textContent = 'Paste at least one Artist - Title line'; return }
    const playlist = { name: name.value.trim() || 'Imported playlist', tracks }
    playlists.push(playlist)
    savePlaylists()
    status.textContent = `Importing ${tracks.length} tracks`
    for (const track of playlist.tracks) await resolvePlaylistTrack(playlist, track)
    savePlaylists()
    showPlaylistEditor(playlists.length - 1)
  })
  actions.append(importButton, back)
  view.append(heading, name, text, actions)
  stage.replaceChildren(view)
  stage.scrollTop = 0
  status.textContent = ''
}

function showPlaylists() {
  setCurrentView(showPlaylists)
  const view = document.createElement('section')
  view.id = 'playlists'
  const heading = document.createElement('header')
  const title = document.createElement('h2')
  title.textContent = 'Playlists'
  const importButton = document.createElement('button')
  importButton.textContent = 'Import text list'
  importButton.addEventListener('click', () => { pushCurrentView(); showPlaylistImport() })
  heading.append(title)
  view.append(heading)
  if (!playlists.length) {
    const empty = document.createElement('section')
    empty.className = 'playlist-empty'
    const icon = document.createElement('span')
    icon.textContent = '♫'
    const emptyTitle = document.createElement('h3')
    emptyTitle.textContent = 'Start with a text list'
    const copy = document.createElement('p')
    copy.textContent = 'Paste Artist - Title lines, match them to YouTube, then keep the playlist editable and exportable.'
    const emptyButton = document.createElement('button')
    emptyButton.textContent = 'Import text list'
    emptyButton.addEventListener('click', () => { pushCurrentView(); showPlaylistImport() })
    empty.append(icon, emptyTitle, copy, emptyButton)
    view.append(empty)
  } else {
    heading.append(importButton)
  }
  playlists.forEach((playlist, index) => {
    const row = document.createElement('article')
    row.className = 'playlist-card'
    const label = document.createElement('div')
    const name = document.createElement('b')
    name.textContent = playlist.name
    const count = document.createElement('small')
    count.textContent = `${playlist.tracks.length} tracks`
    label.append(name, count)
    const edit = document.createElement('button')
    edit.textContent = 'Edit'
    edit.addEventListener('click', () => { pushCurrentView(); showPlaylistEditor(index) })
    const exportButton = document.createElement('button')
    exportButton.textContent = 'Export'
    exportButton.addEventListener('click', () => downloadPlaylist(playlist))
    const remove = document.createElement('button')
    remove.textContent = 'Delete'
    remove.addEventListener('click', () => { playlists.splice(index, 1); savePlaylists(); showPlaylists() })
    row.append(label, edit, exportButton, remove)
    view.append(row)
  })
  stage.replaceChildren(view)
  stage.scrollTop = 0
  status.textContent = 'Playlists'
}

function showBlocked() {
  setCurrentView(showBlocked)
  const list = document.createElement('section')
  list.id = 'block-list'
  const title = document.createElement('h2')
  title.textContent = 'Blocked'
  list.append(title)
  if (!blocked.length) { const empty = document.createElement('p'); empty.textContent = 'No blocked videos or channels.'; list.append(empty) }
  for (const item of blocked) {
    const row = document.createElement('div')
    if (item.thumbnail) { const image = document.createElement('img'); image.src = item.thumbnail; image.alt = ''; image.draggable = false; row.append(image) }
    const details = document.createElement('span')
    const label = document.createElement('b')
    label.textContent = item.label || item.value
    const kind = document.createElement('small')
    kind.textContent = item.kind === 'channel' ? 'Blocked channel' : 'Blocked video'
    details.append(label, kind)
    const remove = document.createElement('button')
    remove.textContent = 'Unblock'
    remove.addEventListener('click', async () => { await invoke('unblock_item', item); blocked = blocked.filter(block => block.kind !== item.kind || block.value !== item.value); showBlocked() })
    row.append(details, remove)
    list.append(row)
  }
  stage.replaceChildren(list)
  status.textContent = 'Blocked'
}

async function renderNavigation() {
  navPanel.replaceChildren()
  const navIcons: Record<string, string> = {
    Home: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m11.485 2.143-8 4.8-2 1.2a1 1 0 001.03 1.714L3 9.567V20a2 2 0 002 2h5v-8h4v8h5a2 2 0 002-2V9.567l.485.29a1 1 0 001.03-1.714l-2-1.2-8-4.8a1 1 0 00-1.03 0Z"></path></svg>',
    Shorts: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m13.467 1.19-8 4.7a5 5 0 00-.255 8.46 5 5 0 005.32 8.462l8-4.7a5 5 0 00.258-8.462 5 5 0 001.641-6.464l-.12-.217a5 5 0 00-6.844-1.78m5.12 2.79a2.999 2.999 0 01-1.067 4.107l-1.327.78a1 1 0 00.096 1.775l.943.423a3 3 0 01.288 5.323l-8 4.7a3 3 0 01-3.039-5.173l1.327-.78a1 1 0 00-.097-1.775l-.942-.423a3 3 0 01-.288-5.323l8-4.7a3 3 0 014.106 1.066ZM15 12l-5-3v6l5-3Z"></path></svg>',
    Subscriptions: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 1H6a2 2 0 00-2 2h16a2 2 0 00-2-2Zm3 4H3a2 2 0 00-2 2v13a2 2 0 002 2h18a2 2 0 002-2V7a2 2 0 00-2-2ZM3 20V7h18v13H3Zm13-6.5L10 10v7l6-3.5Z"></path></svg>',
    You: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 1C5.925 1 1 5.925 1 12s4.925 11 11 11 11-4.925 11-11S18.075 1 12 1Zm0 2a9 9 0 016.447 15.276 7 7 0 00-12.895 0A9 9 0 0112 3Zm0 2a4 4 0 100 8 4 4 0 000-8Zm0 2a2 2 0 110 4 2 2 0 010-4Zm-.1 9.001L11.899 16a5 5 0 014.904 3.61A8.96 8.96 0 0112 21a8.96 8.96 0 01-4.804-1.391 5 5 0 014.704-3.608Z"></path></svg>'
  }
  const action = (label: string, icon: string, handler: () => void) => { const button = document.createElement('button'); button.className = 'nav-action'; button.innerHTML = `<span aria-hidden="true">${navIcons[label] || icon}</span>${label}`; button.addEventListener('click', handler); return button }
  const closeNavigation = () => { navPanel.classList.remove('open'); navScrim.classList.remove('open') }
  const home = action('Home', '⌂', () => { closeNavigation(); loadHome() })
  const shorts = action('Shorts', '▷', () => { closeNavigation(); loadShorts() })
  const historyButton = action('History', '↶', () => {
    closeNavigation()
    if (!history.length) { stage.replaceChildren(); status.textContent = 'No history yet'; return }
    showResults(history, true)
    status.textContent = 'History'
  })
  const playlistsButton = action('Playlists', '♫', () => { closeNavigation(); showPlaylists() })
  const blockedButton = action('Blocked', '⊘', () => { closeNavigation(); showBlocked() })
  const library = document.createElement('b')
  library.textContent = 'You'
  const heading = document.createElement('div')
  heading.className = 'subscription-heading'
  const headingLabel = document.createElement('b')
  headingLabel.textContent = 'Subscriptions'
  heading.append(headingLabel)
  navPanel.append(home, shorts, library, historyButton, playlistsButton, blockedButton, heading)
  try {
    const subscriptions = await invoke<{ channel: string, channel_id: string, avatar: string }[]>('list_subscriptions')
    const exportButton = document.createElement('button')
    exportButton.className = 'subscription-transfer'
    const exportIcon = document.createElement('img')
    exportIcon.src = '/subscription-export.png'
    exportIcon.alt = ''
    exportButton.append(exportIcon)
    exportButton.title = 'Export subscriptions'
    exportButton.ariaLabel = 'Export subscriptions'
    exportButton.addEventListener('click', () => { const file = new Blob([JSON.stringify(subscriptions, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(file); const link = document.createElement('a'); link.href = url; link.download = 'tauritube-subscriptions.json'; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000) })
    const importButton = document.createElement('button')
    importButton.className = 'subscription-transfer'
    const importIcon = document.createElement('img')
    importIcon.src = '/subscription-import.png'
    importIcon.alt = ''
    importButton.append(importIcon)
    importButton.title = 'Import subscriptions'
    importButton.ariaLabel = 'Import subscriptions'
    importButton.addEventListener('click', () => {
      const existing = navPanel.querySelector('#subscription-import')
      if (existing) { existing.remove(); return }
      const panel = document.createElement('section')
      panel.id = 'subscription-import'
      const text = document.createElement('textarea')
      text.placeholder = 'Paste an exported subscription list or one channel per line'
      const apply = document.createElement('button')
      apply.textContent = 'Import'
      apply.addEventListener('click', async () => { try { const parsed = JSON.parse(text.value); const items = Array.isArray(parsed) ? parsed : []; for (const entry of items) { const item = typeof entry === 'string' ? { channel: entry } : entry; if (typeof item?.channel === 'string' && item.channel.trim()) await invoke('subscribe_channel', { channel: item.channel.trim(), channelId: item.channel_id || '', avatar: item.avatar || undefined }) } await renderNavigation() } catch { const items = text.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean); for (const channel of items) await invoke('subscribe_channel', { channel, channelId: '' }); await renderNavigation() } })
      panel.append(text, apply)
      heading.after(panel)
    })
    heading.append(importButton, exportButton)
    for (const item of subscriptions) {
      const row = document.createElement('div')
      row.className = 'subscription'
      const avatar = document.createElement('span')
      avatar.className = 'subscription-avatar'
      avatar.textContent = item.channel.trim().slice(0, 1).toUpperCase() || '?'
      const setAvatar = (source: string) => { if (!source) return; const image = document.createElement('img'); image.src = source; image.alt = ''; image.loading = 'lazy'; image.decoding = 'async'; image.draggable = false; avatar.replaceChildren(image) }
      setAvatar(item.avatar)
      if (!item.avatar) void invoke<string>('load_subscription_avatar', { channel: item.channel, channelId: item.channel_id }).then(setAvatar).catch(() => {})
      const channel = document.createElement('button')
      channel.textContent = item.channel
      channel.addEventListener('click', () => { closeNavigation(); loadChannelVideos(item) })
      const remove = document.createElement('button')
      remove.textContent = '×'
      remove.ariaLabel = `Remove ${item.channel}`
      remove.addEventListener('click', async () => {
        const confirm = row.querySelector<HTMLButtonElement>('.subscription-confirm')
        if (confirm) { confirm.remove(); row.classList.remove('confirming'); remove.textContent = '×'; remove.ariaLabel = `Remove ${item.channel}`; return }
        row.classList.add('confirming')
        remove.textContent = 'Cancel'
        remove.ariaLabel = `Cancel removing ${item.channel}`
        const approve = document.createElement('button')
        approve.className = 'subscription-confirm'
        approve.textContent = 'Remove'
        approve.addEventListener('click', async () => { await invoke('unsubscribe_channel', { channel: item.channel }); renderNavigation() })
        row.append(approve)
      })
      row.append(avatar, channel, remove)
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
    shortsResults = []
    const page = await invoke<SearchPage>('load_shorts')
    if (!page.results.length) { stage.replaceChildren(); status.textContent = 'No shorts found'; return }
    showShorts(page.results)
  } catch (error) { status.textContent = String(error) }
}
function homeQueries() {
  const discovery = ['new music discoveries', 'gaming highlights', 'interesting science videos', 'funny videos', 'relaxing ambience', 'creative coding videos', 'movie trailers', 'live performances']
  const related = history.slice(0, 12).sort(() => Math.random() - 0.5).find(result => result.channel || result.title)
  const query = related?.channel ? `${related.channel} videos` : related?.title.split(/\s+/).slice(0, 6).join(' ')
  return [...new Set([query, ...discovery.sort(() => Math.random() - 0.5).slice(0, 2)].filter(Boolean) as string[])]
}

function mixHomeResults(groups: SearchResult[][]) {
  const results: SearchResult[] = []
  const seen = new Set<string>()
  for (let index = 0; groups.some(group => index < group.length); index++) for (const group of groups) {
    const result = group[index]
    if (result && !seen.has(result.id)) { seen.add(result.id); results.push(result) }
  }
  return results
}

async function loadHome() {
  const request = ++homeLoadId
  document.body.classList.remove('playing', 'chrome-visible')
  document.body.classList.add('browsing')
  const recent = history.slice(0, 8)
  showResults(recent, false, true)
  status.textContent = recent.length ? 'Home · loading more for you' : 'Home · loading'
  const subscriptionFeed = invoke<SearchPage>('load_home')
  try {
    const discovery = await Promise.all(homeQueries().map(query => invoke<SearchPage>('search_youtube', { query })))
    if (request !== homeLoadId) return
    const results = mixHomeResults([recent, ...discovery.map(page => page.results)])
    if (results.length) showResults(results, false, true)
    status.textContent = 'Home'
    const subscriptions = await subscriptionFeed
    if (request !== homeLoadId || !subscriptions.results.length) return
    showResults(mixHomeResults([recent, subscriptions.results, ...discovery.map(page => page.results)]), false, true)
    status.textContent = 'Home'
  } catch (error) { if (request === homeLoadId) status.textContent = String(error) }
}
function loadChannelVideos(subscription: { channel: string, channel_id: string }) { showFeed('load_channel_videos', { channel: subscription.channel, channelId: subscription.channel_id || '' }, subscription.channel) }

async function go() {
  const value = input.value.trim()
  if (!value) return
  searchFor(value)
}

async function searchFor(value: string) {
  pushCurrentView()
  input.value = value
  updateClearButton()
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
brand.addEventListener('click', () => { pushCurrentView(); loadHome() })
input.addEventListener('keydown', event => { if (event.key === 'Enter') go() })
clearButton.addEventListener('click', () => { input.value = ''; updateClearButton(); input.focus() })
document.querySelector('#queue')!.addEventListener('click', () => { queuePanel.classList.toggle('open'); renderQueue() })
miniRestore.addEventListener('click', restoreMiniPlayer)
menu.addEventListener('click', () => { const opening = !navPanel.classList.contains('open'); navPanel.classList.toggle('open', opening); navScrim.classList.toggle('open', opening); if (opening) renderNavigation() })
navScrim.addEventListener('click', () => { navPanel.classList.remove('open'); navScrim.classList.remove('open') })
document.querySelector('#prev-page')!.addEventListener('click', goToPreviousView)
document.querySelector('#next-page')!.addEventListener('click', goToNextView)
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
  if (event.deltaY > 0 && shortIndex >= shortsResults.length - 1) { void loadMoreShorts(shortsResults[shortIndex].id); return }
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
  if (playerBridge && event.data?.action === 'mini') { miniaturize(Number(event.data.time) || undefined); return }
  if (playerBridge && event.data?.action === 'open-channel') { const channel = String(event.data.channel || ''); const channelId = String(event.data.channelId || ''); if (channel || channelId) loadChannelVideos({ channel, channel_id: channelId }); return }
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
