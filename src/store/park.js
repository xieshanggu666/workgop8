import { defineStore } from 'pinia'

const BASE = '/api'

async function j(method, path, body) {
  const opt = { method, headers: { 'Content-Type': 'application/json' } }
  if (body) opt.body = JSON.stringify(body)
  const r = await fetch(BASE + path, opt)
  return r.json()
}

export const useParkStore = defineStore('park', {
  state: () => ({
    data: null,
    loaded: false,
    speed: 1,
    lastTick: 0
  }),
  getters: {
    clock: s => s.data?.clock || { day: 1, hour: 9 },
    zones: s => s.data?.zones || [],
    rides: s => s.data?.rides || [],
    vendors: s => s.data?.vendors || [],
    staff: s => s.data?.staff || [],
    events: s => s.data?.events || [],
    finance: s => s.data?.finance || [],
    visitors: s => s.data?.visitors || [],
    loans: s => s.data?.loans || [],
    debt: s => s.data?.debt || { remainPrincipal: 0, arrears: 0, overdueCount: 0 },
    activeEvents: s => (s.data?.events || []).filter(e => e.status === 'active')
  },
  actions: {
    async refresh() {
      this.data = await j('GET', '/state')
      this.loaded = true
      if (this.data) this.lastTick = this.data.clock.tick
    },
    async api(method, path, body) {
      const r = await j(method, path, body)
      await this.refresh()
      return r
    },
    buildRide(payload) { return this.api('POST', '/rides', payload) },
    updateRide(id, payload) { return this.api('POST', `/rides/${id}`, payload) },
    delRide(id) { return this.api('DELETE', `/rides/${id}`) },
    buildVendor(payload) { return this.api('POST', '/vendors', payload) },
    updateVendor(id, payload) { return this.api('POST', `/vendors/${id}`, payload) },
    delVendor(id) { return this.api('DELETE', `/vendors/${id}`) },
    hire(payload) { return this.api('POST', '/staff', payload) },
    updateStaff(id, payload) { return this.api('POST', `/staff/${id}`, payload) },
    unlock(zoneId) { return this.api('POST', `/zones/${zoneId}/unlock`, {}) },
    updateZone(zoneId, payload) { return this.api('POST', `/zones/${zoneId}`, payload) },
    setTicket(price) { return this.api('POST', '/ticket', { price }) },
    takeLoan(amount, periods, ratePct) { return this.api('POST', '/loan', { amount, periods, ratePct }) },
    repayLoan(id) { return this.api('POST', `/loans/${id}/repay`, {}) },
    planEvent(payload) { return this.api('POST', '/events', payload) },
    resolveEvent(id) { return this.api('POST', `/events/${id}/resolve`, {}) }
  }
})