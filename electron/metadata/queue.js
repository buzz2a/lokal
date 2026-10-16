// One lane per online source: its requests run one after another, at least
// `gapMs` apart (MusicBrainz asks for one a second), whoever makes them.

const lanes = new Map()
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function paced(id, gapMs, work) {
  const lane = lanes.get(id) || { tail: Promise.resolve(), at: 0 }
  lanes.set(id, lane)
  const run = lane.tail.then(async () => {
    const wait = lane.at + gapMs - Date.now()
    if (wait > 0) await sleep(wait)
    try { return await work() } finally { lane.at = Date.now() }
  })
  lane.tail = run.catch(() => {})
  return run
}

/** GET a JSON document through the source's lane; throws with a readable message. */
async function getJson(id, gapMs, url, { fetchImpl = fetch, headers = {}, timeoutMs = 10000 } = {}) {
  return paced(id, gapMs, async () => {
    let res
    try {
      res = await fetchImpl(url, { headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(timeoutMs) })
    } catch (error) {
      throw new Error(error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'did not answer in time' : `unreachable (${error?.cause?.code || error?.message || 'network error'})`)
    }
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`answered ${res.status}`)
    return res.json()
  })
}

module.exports = { paced, getJson }
