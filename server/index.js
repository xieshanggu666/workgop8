import express from 'express'
import db, { getSetting, setSetting } from './db.js'

const app = express()
app.use(express.json())

const PORT = 4150
const HOURS_PER_DAY = 10   // 9:00 ~ 18:00
const OPEN_HOUR = 9
const TICK_MS = 2000

// 分期贷款参数：每 1 个游戏日 = 1 期
const LOAN_PERIOD_CHOICES = [5, 10, 20, 30]   // 可选期数(天)
const LOAN_RATE_CHOICES = [0.005, 0.01, 0.02] // 可选每期利率
const LOAN_MIN = 1000
const LOAN_MAX = 5000000
const OVERDUE_PENALTY = 0.02                  // 逾期挂账每日罚息 2%

const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d }

// ---------------- 工具 ----------------
const state = {
  day: () => num(getSetting('day'), 1),
  hour: () => num(getSetting('hour'), OPEN_HOUR),
  tick: () => num(getSetting('tick'), 0),
  cash: () => num(getSetting('cash'), 0),
  reputation: () => num(getSetting('reputation'), 70),
  ticket: () => num(getSetting('ticket'), 120),
  guestBase: () => num(getSetting('guestBase'), 600)
}

const allZones = () => db.prepare('SELECT * FROM zones ORDER BY id').all()
const openZones = () => db.prepare('SELECT * FROM zones WHERE open=1').all()
const allRides = () => db.prepare('SELECT * FROM rides ORDER BY id').all()
const operatingRides = () => db.prepare("SELECT * FROM rides WHERE status='operating'").all()
const allVendors = () => db.prepare('SELECT * FROM vendors ORDER BY id').all()
const allStaff = () => db.prepare('SELECT * FROM staff ORDER BY id').all()

function logFinance(day, label, amount, detail) {
  db.prepare('INSERT INTO finance(tick,day,label,amount,detail) VALUES(?,?,?,?,?)')
    .run(state.tick(), day, label, Math.round(amount), detail || '')
}

// ---------------- 分期贷款 ----------------
const activeLoans = () => db.prepare("SELECT * FROM loans WHERE status='active' ORDER BY id").all()

// 未偿本金合计（剩余本金，不含利息）
function loanDebt() {
  return activeLoans().reduce((s, l) => s + l.remain_principal, 0)
}

// 贷款汇总：剩余本金、挂账(逾期)金额、逾期贷款数
function debtSummary() {
  const ls = activeLoans()
  return {
    remainPrincipal: ls.reduce((s, l) => s + l.remain_principal, 0),
    arrears: ls.reduce((s, l) => s + l.arrears_p + l.arrears_i, 0),
    overdueCount: ls.filter(l => l.arrears_p + l.arrears_i > 0).length
  }
}

// 等额本息每期应还（末期靠尾款兜底，保证正好还清）
function calcInstallment(principal, rate, periods) {
  if (!rate) return Math.round(principal / periods)
  const pay = principal * rate * Math.pow(1 + rate, periods) / (Math.pow(1 + rate, periods) - 1)
  return Math.round(pay)
}

// 日结扣款（每天 1 期）；cash 为入参形式，返回 { cash, overdueHits, overdueIds }
function settleLoans(cash, day) {
  let overdueHits = 0
  const overdueIds = []
  for (const l of activeLoans()) {
    let dueP = 0, dueI = 0
    if (l.arrears_p + l.arrears_i > 0) {
      // 有逾期挂账：按挂账总额每日加罚息，先清欠账，不顺延新一期
      const penalty = Math.round((l.arrears_p + l.arrears_i) * OVERDUE_PENALTY)
      dueP = l.arrears_p
      dueI = l.arrears_i + penalty
    } else if (l.paid_periods < l.periods) {
      // 正常到期：末期收剩余本金 + 当期利息
      dueI = Math.round(l.remain_principal * l.rate)
      dueP = l.paid_periods + 1 >= l.periods
        ? l.remain_principal
        : Math.min(l.installment - dueI, l.remain_principal)
    } else continue

    const due = dueP + dueI
    const wasOverdue = (l.arrears_p + l.arrears_i) > 0
    if (cash >= due) {
      // 足额还款
      cash -= due
      if (dueI > 0) logFinance(day, '利息', -dueI, `贷款 #${l.id} 第${l.paid_periods + 1}期利息${wasOverdue ? '(含罚息)' : ''}`)
      if (dueP > 0) logFinance(day, '贷款', -dueP, `偿还贷款 #${l.id} 第${l.paid_periods + 1}期本金`)
      const remainPrincipal = Math.max(0, l.remain_principal - dueP)
      const paidPeriods = wasOverdue ? l.paid_periods : l.paid_periods + 1
      // 逾期补缴可能使本金先于期数归零，本金还清即结清
      const finished = remainPrincipal <= 0
      const upd = finished
        ? db.prepare("UPDATE loans SET remain_principal=?, paid_periods=?, arrears_p=0, arrears_i=0, status='done' WHERE id=?")
        : db.prepare('UPDATE loans SET remain_principal=?, paid_periods=?, arrears_p=0, arrears_i=0 WHERE id=?')
      upd.run(remainPrincipal, paidPeriods, l.id)
    } else {
      // 现金不足：按 利息(含罚息) → 本金 的顺序部分偿还，余额挂账并转逾期
      let avail = Math.max(0, cash)
      const payI = Math.min(dueI, avail)
      avail -= payI
      const payP = Math.min(dueP, avail)
      avail -= payP
      cash -= payI + payP
      if (payI > 0) logFinance(day, '利息', -Math.round(payI), `贷款 #${l.id} 部分付息(现金不足)`)
      if (payP > 0) logFinance(day, '贷款', -Math.round(payP), `贷款 #${l.id} 部分还本(现金不足)`)
      const leftI = dueI - payI
      const leftP = dueP - payP
      db.prepare('UPDATE loans SET remain_principal=?, arrears_p=?, arrears_i=?, overdue_days=overdue_days+1 WHERE id=?')
        .run(Math.max(0, l.remain_principal - payP), Math.round(leftP), Math.round(leftI), l.id)
      overdueHits += 1
      overdueIds.push(l.id)
    }
  }
  return { cash, overdueHits, overdueIds }
}

// ---------------- 游戏主循环 ----------------
function tick() {
  let day = state.day()
  let hour = state.hour() + 1
  let cash = state.cash()
  let rep = state.reputation()
  const ticket = state.ticket()
  const base = state.guestBase()

  let tickCount = state.tick() + 1
  setSetting('tick', tickCount)

  // 跨天结算
  let overdueHits = 0
  let overdueIds = []
  if (hour > OPEN_HOUR + HOURS_PER_DAY - 1) {
    hour = OPEN_HOUR
    // 日结工资
    const wage = allStaff().filter(s => s.active).reduce((s, st) => s + st.wage, 0)
    cash -= wage
    logFinance(day, '工资', -wage, '当日员工工资')
    // 日结租金
    const rent = allVendors().reduce((s, v) => s + v.rent, 0)
    cash -= rent
    logFinance(day, '租金', -rent, '当日商铺租金')
    // 日结分期贷款：同步扣款；现金不足时按 利息→本金 部分偿还并转逾期挂账
    const settled = settleLoans(cash, day)
    cash = settled.cash
    overdueHits = settled.overdueHits
    overdueIds = settled.overdueIds
    day += 1
    setSetting('day', day)
  }
  setSetting('hour', hour)

  // 入园人数模型
  const retail = hour <= 6 ? 0.5 : hour >= 16 ? 0.6 : 1   // 早晚人少
  const priceFactor = Math.max(0.2, 2.0 - ticket / 100)     // 价越高人越少
  const repFactor = 0.4 + rep / 100
  const zoneFactor = 1
  const entering = Math.round(base * retail * priceFactor * repFactor * zoneFactor * (0.85 + Math.random() * 0.3))
  const satisfaction = computeSatisfaction()
  const avgSpend = 40 + satisfaction / 5 + Math.random() * 15
  const spend = Math.round(entering * (avgSpend * 0.15 + ticket * 0.5)) // 门票为主的收入模型

  // 门票收入
  const ticketRev = Math.round(entering * ticket)
  cash += ticketRev
  if (ticketRev > 0) logFinance(day, '门票', ticketRev, `入园 ${entering} 人·当日票`)

  const zones = allZones()
  // 游客在各开放的游玩区域分配
  const ops = operatingRides()
  const totalAttr = ops.reduce((s, r) => s + r.attr * (r.health / 100), 1)
  let rideIncome = 0
  const rideStmt = db.prepare('UPDATE rides SET queue=?, play_count=play_count+?, rev=rev+?, health=? WHERE id=?')
  const newRides = ops.map(r => {
    const share = (r.attr * (r.health / 100)) / totalAttr
    const riders = Math.min(Math.round(entering * 1.6 * share), r.capacity * 6)
    const income = Math.round(riders * r.price)
    rideIncome += income
    cash += income
    // 健康度随时间小幅衰减
    const decay = r.thrill > 80 ? 1.8 : r.thrill > 50 ? 1.1 : 0.7
    const health = Math.max(0, r.health - decay)
    const queue = Math.max(0, riders - r.capacity * 2) * 0.6
    rideStmt.run(Math.round(queue), riders, income, Math.round(health * 10) / 10, r.id)
    return { ...r, riders, income }
  }).filter(Boolean)
  if (rideIncome > 0) logFinance(day, '游乐', rideIncome, '游乐设施营收')

  // 设施运行成本
  let runCost = 0
  ops.forEach(r => {
    if (r.status === 'operating') { runCost += r.run_cost; cash -= r.run_cost }
  })
  if (runCost > 0) logFinance(day, '运营', -runCost, '设施运行成本')

  // 清扫/安保维护 = 保洁保安数量相关；干净度随时间降低
  const cleaters = allStaff().filter(s => s.role === '保洁' && s.active).length
  const guards = allStaff().filter(s => s.role === '保安' && s.active).length
  for (const z of zones) {
    let c = z.cleanliness
    c -= 2.5
    if (cleaters > 0) c += 3.5 * Math.min(cleaters, 3)
    c = Math.max(5, Math.min(100, c))
    const scenery = z.scenery + (z.scenery < 60 ? 0.2 : 0)
    db.prepare('UPDATE zones SET cleanliness=? WHERE id=?').run(Math.round(c), z.id)
  }

  // 商铺营收
  const activeZoneIds = zones.filter(z => z.open).map(z => z.id)
  const vendors = allVendors().filter(v => activeZoneIds.includes(v.zone_id))
  const vStmt = db.prepare('UPDATE vendors SET sold=sold+?, rev=rev+? WHERE id=?')
  let vendorIncome = 0
  for (const v of vendors) {
    const zone = zones.find(z => z.id === v.zone_id)
    const zFlow = (zone ? zone.capacity : 150) * (satisfaction / 100)
    const sold = Math.round(Math.min(zFlow / 8, entering / 6) * (0.8 + Math.random() * 0.4))
    const income = Math.round(sold * v.price * v.margin)
    vendorIncome += income
    cash += income
    vStmt.run(sold, income, v.id)
  }
  if (vendorIncome > 0) logFinance(day, '商业', vendorIncome, '商铺营收')

  // 员工满意度
  const sm = db.prepare('UPDATE staff SET morale=? WHERE id=?')
  allStaff().forEach(s => {
    if (!s.active) return
    let m = s.morale + (s.wage > 360 ? 1.2 : -0.3) + (Math.random() * 1 - 0.5)
    m = Math.max(20, Math.min(100, m))
    sm.run(Math.round(m), s.id)
  })

  // 事件影响
  const es = allEvents.actives()
  let eventRepShift = 0
  for (const e of es) {
    if (e.impact && e.status === 'active') eventRepShift += (e.impact > 0 ? 0.8 : -1.6)
  }

  // 声誉演化：满意度+事件+预算健康度
  const budgetHealth = cash > 0 ? Math.min(1, cash / 200000) : -0.4
  rep = Math.max(5, Math.min(100, rep + (satisfaction - 70) * 0.15 + budgetHealth * 2 + eventRepShift))

  // 贷款逾期：信用受损（本次日结新产生的逾期，每条 -1.5 声誉）
  if (overdueHits > 0) {
    rep = Math.max(5, rep - 1.5 * overdueHits)
    const ids = overdueIds.join('、#')
    db.prepare('INSERT INTO events(tick,day,type,title,desc,impact,status) VALUES(?,?,?,?,?,?,?)')
      .run(tickCount, day, 'overdue', '贷款还款逾期', `日结时现金不足以偿还分期贷款 #${ids}，欠款已挂账并按日计 2% 罚息，后续日结将优先补扣。`, -2, 'active')
  }

  // 满意度驱动消费
  const eatSpend = Math.round(entering * avgSpend * 0.3)
  cash += eatSpend
  if (eatSpend > 0) logFinance(day, '消费', eatSpend, '园内消费')

  db.prepare('INSERT INTO visitors(tick,day,hour,count,satisfaction,eat,total_spend) VALUES(?,?,?,?,?,?,?)')
    .run(tickCount, day, hour, entering, Math.round(satisfaction * 10) / 10, Math.round(avgSpend * 10) / 10, Math.round(spend * 10) / 10)

  setSetting('cash', Math.round(cash))
  setSetting('reputation', Math.round(rep * 10) / 10)

  // 随机事件
  maybeSpawnEvent(day)

  checkBrokenDown(day)
}

function computeSatisfaction() {
  const zones = allZones()
  const avgClean = zones.length ? zones.reduce((s, z) => s + z.cleanliness, 0) / zones.length : 70
  const ops = operatingRides()
  const openRatio = (allRides().length ? ops.length / allRides().length : 1)
  let sat = 50
  sat += (avgClean - 60) * 0.5
  sat += openRatio * 35
  const longQueue = ops.filter(r => r.queue > r.capacity * 4).length
  sat -= longQueue * 3
  sat += state.reputation() * 0.2
  return Math.max(10, Math.min(100, sat))
}

// ---------------- 事件系统 ----------------
const allEvents = {
  actives: () => db.prepare("SELECT * FROM events WHERE status='active'").all()
}

const EVENT_POOL = [
  { type: 'weather', title: '午后阵雨', desc: '降雨影响游客体验，入园客流下降，清洁压力增大。', impact: -1 },
  { type: 'crowd', title: '客流高峰', desc: '游客激增，设施队列变长，需增派保洁缓解拥挤。', impact: 1 },
  { type: 'fault', title: '设备故障隐患', desc: '一台高刺激设施发出异响，建议立即停运检修。', impact: -2 },
  { type: 'celebrity', title: '明星到访', desc: '知名艺人入园引发关注，声望提升，周边商铺客流大增。', impact: 2 },
  { type: 'protest', title: '排队投诉潮', desc: '游客因排队时间过长集中投诉。', impact: -2 },
  { type: 'fever', title: '节令热潮', desc: '季节主题推动消费，游客日均消费上升。', impact: 1 }
]

function maybeSpawnEvent(day) {
  if (Math.random() > 0.12) return
  const ev = EVENT_POOL[Math.floor(Math.random() * EVENT_POOL.length)]
  db.prepare('INSERT INTO events(tick,day,type,title,desc,impact,status) VALUES(?,?,?,?,?,?,?)')
    .run(state.tick(), day, ev.type, ev.title, ev.desc, ev.impact, 'active')
}

function checkBrokenDown(day) {
  const bad = db.prepare("SELECT * FROM rides WHERE health<25 AND status='operating'").all()
  for (const r of bad) {
    db.prepare("UPDATE rides SET status='maintenance' WHERE id=?").run(r.id)
  }
  const sound = db.prepare("SELECT * FROM rides WHERE health>95 AND status='maintenance'").all()
  for (const r of sound) {
    db.prepare("UPDATE rides SET status='operating' WHERE id=?").run(r.id)
  }
}

// 启动循环
tick()
setInterval(tick, TICK_MS)

// ---------------- API ----------------
app.get('/api/state', (req, res) => {
  const rides = allRides()
  const visitors = db.prepare('SELECT * FROM visitors ORDER BY id DESC LIMIT 60').all().reverse()
  const fin = db.prepare('SELECT * FROM finance ORDER BY id DESC LIMIT 80').all().reverse()
  const loans = activeLoans().map(l => {
    const arrears = l.arrears_p + l.arrears_i
    const nextI = l.paid_periods < l.periods ? Math.round(l.remain_principal * l.rate) : 0
    const nextP = l.paid_periods + 1 >= l.periods ? l.remain_principal : Math.min(l.installment - nextI, l.remain_principal)
    return {
      ...l,
      ratePct: Math.round(l.rate * 1000) / 10,
      arrears,
      nextDue: l.paid_periods < l.periods ? nextP + nextI : 0,
      nextPrincipal: nextP,
      nextInterest: nextI,
      over: arrears > 0
    }
  })
  return res.json({
    clock: { day: state.day(), hour: state.hour(), tick: state.tick() },
    cash: state.cash(),
    reputation: state.reputation(),
    ticket: state.ticket(),
    loan: loanDebt(),
    loans,
    debt: debtSummary(),
    loanChoices: { periods: LOAN_PERIOD_CHOICES, rates: LOAN_RATE_CHOICES.map(r => Math.round(r * 1000) / 10) },
    visitorToday: visitors.filter(v => v.day === state.day()).reduce((s, v) => s + v.count, 0),
    visitors,
    zones: allZones(),
    rides,
    vendors: allVendors(),
    staff: allStaff(),
    events: db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 40').all(),
    finance: fin,
    avgs: {
      satisfaction: computeSatisfaction(),
      openRatio: rides.length ? operatingRides().length / rides.length : 0
    }
  })
})

app.get('/api/summary', (req, res) => {
  const riders = db.prepare("SELECT SUM(play_count) n, SUM(rev) s FROM rides").get()
  return res.json({
    totalRidePlays: riders.n || 0,
    totalRideRev: riders.s || 0,
    totalVisitors: (db.prepare('SELECT SUM(count) n FROM visitors').get().n || 0),
    totalEvents: db.prepare('SELECT COUNT(*) n FROM events').get().n,
    finance: db.prepare('SELECT label, SUM(amount) amount FROM finance GROUP BY label').all()
  })
})

// ---- 设施 ----
app.post('/api/rides', (req, res) => {
  const b = req.body || {}
  const type = b.type || '过山车'
  const zone_id = num(b.zone_id, 1)
  const name = b.name || `${type} · 新建`
  const preset = {
    '过山车': [32, 6, 60000, 260, 92], '旋转木马': [40, 4, 20000, 70, 15],
    '摩天轮': [24, 12, 45000, 150, 45], '跳楼机': [20, 8, 35000, 130, 88],
    '碰碰车': [12, 5, 26000, 95, 60], '海盗船': [30, 7, 38000, 140, 78],
    '水上漂流': [28, 9, 42000, 160, 82], '云霄飞车': [22, 10, 52000, 200, 90]
  }[type] || [20, 5, 30000, 100, 60]
  const [capacity, cycle, cost, run_cost, thrill] = preset
  let cash = state.cash()
  if (cash < cost) return res.status(400).json({ ok: false, msg: '资金不足' })
  cash -= cost
  setSetting('cash', Math.round(cash))
  const r = db.prepare('INSERT INTO rides(name,type,zone_id,status,capacity,cycle_min,build_cost,run_cost,thrill,attr,price,pos_row,pos_col) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(name, type, zone_id, 'operating', capacity, cycle, cost, run_cost, thrill, 60 + thrill * 0.2, Math.max(20, Math.round(thrill * 0.6)), req.body.pos_row || 0, req.body.pos_col || 0)
  logFinance(state.day(), '建设', -cost, `建造 ${name}`)
  res.json({ ok: true, id: Number(r.lastInsertRowid) })
})

app.post('/api/rides/:id', (req, res) => {
  const id = num(req.params.id)
  const b = req.body || {}
  const sets = []
  const vals = []
  if (b.status) { sets.push('status=?'); vals.push(b.status) }
  if (b.price) { sets.push('price=?'); vals.push(num(b.price)) }
  if (b.name) { sets.push('name=?'); vals.push(b.name) }
  if (b.thrill && b.upgrade) {
    // 升级刺激度花成本提升吸引度
    const up = num(b.upgrade, 0)
    sets.push('thrill=thrill+?'); vals.push(up)
    sets.push('attr=attr+?'); vals.push(up * 0.3)
    let cash = state.cash()
    const cost = up * 3000
    cash -= cost
    setSetting('cash', Math.round(cash))
    logFinance(state.day(), '升级', -cost, `升级设施 #${id}`)
  }
  if (b.repair) {
    sets.push("health=? , status='operating'"); vals.push(100)
    let cash = state.cash()
    const cost = 5000
    cash -= cost
    setSetting('cash', Math.round(cash))
    logFinance(state.day(), '维护', -cost, `检修设施 #${id}`)
  }
  if (!sets.length) return res.json({ ok: false, msg: '无更新项' })
  vals.push(id)
  db.prepare(`UPDATE rides SET ${sets.join(',')} WHERE id=?`).run(...vals)
  res.json({ ok: true })
})

app.delete('/api/rides/:id', (req, res) => {
  const id = num(req.params.id)
  db.prepare('DELETE FROM rides WHERE id=?').run(id)
  res.json({ ok: true })
})

// ---- 商铺 ----
app.post('/api/vendors', (req, res) => {
  const b = req.body || {}
  const type = b.type || '餐饮'
  const preset = { '餐饮': [0.62, 1000, 32], '纪念品': [0.7, 1200, 45], '饮品': [0.72, 600, 18] }[type] || [0.6, 800, 25]
  const [margin, rent, price] = preset
  let cash = state.cash()
  const buildCost = 8000
  if (cash < buildCost) return res.status(400).json({ ok: false, msg: '资金不足' })
  cash -= buildCost
  setSetting('cash', Math.round(cash))
  const r = db.prepare('INSERT INTO vendors(name,type,zone_id,rent,margin,price,pos_row,pos_col) VALUES(?,?,?,?,?,?,?,?)')
    .run(b.name || `新${type}摊`, type, num(b.zone_id, 1), rent, margin, price, b.pos_row || 0, b.pos_col || 0)
  logFinance(state.day(), '建设', -buildCost, `开设 ${type} 商铺`)
  res.json({ ok: true, id: Number(r.lastInsertRowid) })
})

app.post('/api/vendors/:id', (req, res) => {
  const id = num(req.params.id)
  const b = req.body || {}
  if (b.price) db.prepare('UPDATE vendors SET price=? WHERE id=?').run(num(b.price), id)
  if (b.staff_id !== undefined) {
    const sid = b.staff_id ? num(b.staff_id) : null
    db.prepare('UPDATE vendors SET staff_id=? WHERE id=?').run(sid, id)
    if (sid) db.prepare("UPDATE staff SET assigned_ride_id=NULL WHERE id=?").run(sid)
  }
  res.json({ ok: true })
})

app.delete('/api/vendors/:id', (req, res) => {
  db.prepare('DELETE FROM vendors WHERE id=?').run(num(req.params.id))
  res.json({ ok: true })
})

// ---- 员工 ----
const ROLES = ['保安', '保洁', '维修']
app.post('/api/staff', (req, res) => {
  const b = req.body || {}
  const role = b.role || '保安'
  if (!ROLES.includes(role)) return res.status(400).json({ ok: false, msg: '非法岗位' })
  const wage = role === '维修' ? 380 : role === '保洁' ? 300 : 320
  const r = db.prepare('INSERT INTO staff(name,role,zone_id,wage,skill,morale,active) VALUES(?,?,?,?,?,?,?)')
    .run(b.name || `新员工`, role, num(b.zone_id, 1), wage, 1, 80, 1)
  res.json({ ok: true, id: Number(r.lastInsertRowid) })
})

app.post('/api/staff/:id', (req, res) => {
  const id = num(req.params.id)
  const b = req.body || {}
  if (b.zone_id) db.prepare('UPDATE staff SET zone_id=? WHERE id=?').run(num(b.zone_id), id)
  if (b.active !== undefined) db.prepare('UPDATE staff SET active=? WHERE id=?').run(b.active ? 1 : 0, id)
  if (b.assignRide) db.prepare('UPDATE staff SET assigned_ride_id=? WHERE id=?').run(num(b.assignRide), id)
  if (b.assignVendor) db.prepare('UPDATE staff SET assigned_ride_id=? WHERE id=?').run(num(b.assignVendor), id)
  res.json({ ok: true })
})

// ---- 区域 ----
app.post('/api/zones/:id/unlock', (req, res) => {
  const id = num(req.params.id)
  const z = db.prepare('SELECT * FROM zones WHERE id=?').get(id)
  if (!z) return res.status(404).json({ ok: false })
  let cash = state.cash()
  const cost = 80000
  if (cash < cost) return res.status(400).json({ ok: false, msg: '资金不足' })
  cash -= cost
  setSetting('cash', Math.round(cash))
  db.prepare('UPDATE zones SET unlocked=1, open=1 WHERE id=?').run(id)
  logFinance(state.day(), '扩建', -cost, `开放「${z.name}」`)
  res.json({ ok: true })
})

app.post('/api/zones/:id', (req, res) => {
  const id = num(req.params.id)
  const b = req.body || {}
  if (b.open !== undefined) db.prepare('UPDATE zones SET open=? WHERE id=?').run(b.open ? 1 : 0, id)
  if (b.scenery !== undefined) db.prepare('UPDATE zones SET scenery=? WHERE id=?').run(num(b.scenery), id)
  res.json({ ok: true })
})

// ---- 票务 / 分期贷款 ----
app.post('/api/ticket', (req, res) => {
  const p = num(req.body?.price, 120)
  setSetting('ticket', Math.max(10, Math.min(500, p)))
  res.json({ ok: true, ticket: num(getSetting('ticket')) })
})

// 申请分期贷款：可选期数(天)与每期利率，等额本息
app.post('/api/loan', (req, res) => {
  const amount = Math.round(num(req.body?.amount))
  const periods = Math.round(num(req.body?.periods, 10))
  // 前端以百分数传入（1 表示每期 1%）
  const rate = req.body?.ratePct !== undefined
    ? num(req.body.ratePct) / 100
    : num(req.body?.rate, 0.01)
  if (!Number.isFinite(amount) || amount < LOAN_MIN || amount > LOAN_MAX) {
    return res.status(400).json({ ok: false, msg: `贷款金额需在 ${LOAN_MIN.toLocaleString()} ~ ${LOAN_MAX.toLocaleString()} 之间` })
  }
  if (!Number.isInteger(periods) || periods < 1 || periods > 60) {
    return res.status(400).json({ ok: false, msg: '期数需为 1~60 之间的整数（天）' })
  }
  if (!Number.isFinite(rate) || rate < 0 || rate > 0.05) {
    return res.status(400).json({ ok: false, msg: '每期利率需在 0% ~ 5% 之间' })
  }
  const installment = calcInstallment(amount, rate, periods)
  const day = state.day()
  const r = db.prepare(`INSERT INTO loans(principal,rate,periods,installment,remain_principal,start_day,created_tick)
                        VALUES(?,?,?,?,?,?,?)`)
    .run(amount, rate, periods, installment, amount, day, state.tick())
  const cash = state.cash() + amount
  setSetting('cash', Math.round(cash))
  logFinance(day, '贷款', amount, `取得分期贷款 #${r.lastInsertRowid}：${periods} 期 · 每期 ${Math.round(rate * 1000) / 10}% · 月供 ¥${installment.toLocaleString()}`)
  res.json({ ok: true, id: Number(r.lastInsertRowid), installment, periods, ratePct: Math.round(rate * 1000) / 10, loan: loanDebt() })
})

// 提前结清单笔贷款：仅收取剩余本金与已产生的逾期利息/罚息，豁免未到期利息
app.post('/api/loans/:id/repay', (req, res) => {
  const id = num(req.params.id)
  const l = db.prepare("SELECT * FROM loans WHERE id=? AND status='active'").get(id)
  if (!l) return res.status(404).json({ ok: false, msg: '贷款不存在或已结清' })
  const need = l.remain_principal + l.arrears_i
  const cash = state.cash()
  if (cash < need) return res.status(400).json({ ok: false, msg: `资金不足，结清需 ¥${need.toLocaleString()}` })
  const day = state.day()
  if (l.arrears_i > 0) logFinance(day, '利息', -l.arrears_i, `贷款 #${l.id} 结清逾期利息/罚息`)
  logFinance(day, '贷款', -l.remain_principal, `提前结清贷款 #${l.id} 本金`)
  setSetting('cash', Math.round(cash - need))
  db.prepare("UPDATE loans SET remain_principal=0, arrears_p=0, arrears_i=0, status='done' WHERE id=?").run(l.id)
  res.json({ ok: true, loan: loanDebt() })
})

// ---- 活动与事件 ----
app.post('/api/events', (req, res) => {
  const b = req.body || {}
  let cash = state.cash()
  const budget = num(b.budget, 8000)
  if (cash < budget) return res.status(400).json({ ok: false, msg: '资金不足' })
  cash -= budget
  setSetting('cash', Math.round(cash))
  const impact = b.type === '烟火' || b.type === '花车巡游' ? 2 : 1
  db.prepare('INSERT INTO events(tick,day,type,title,desc,impact,status) VALUES(?,?,?,?,?,?,?)')
    .run(state.tick(), state.day(), b.type, b.title || `${b.type}活动`, b.desc || '策划的园区活动', impact, 'active')
  logFinance(state.day(), '活动', -budget, `举办 ${b.title || '活动'}`)
  res.json({ ok: true })
})

app.post('/api/events/:id/resolve', (req, res) => {
  const id = num(req.params.id)
  const ev = db.prepare('SELECT * FROM events WHERE id=?').get(id)
  if (!ev) return res.status(404).json({ ok: false })
  db.prepare("UPDATE events SET status='resolved', feedback=? WHERE id=?").run('通过决策处理', id)
  // 处理得当可挽回部分声誉损失
  if (ev.impact < 0) {
    let rep = state.reputation() + Math.abs(ev.impact) * 5
    setSetting('reputation', Math.max(5, Math.min(100, rep)))
  }
  res.json({ ok: true })
})

app.listen(PORT, () => console.log(`[PARK] API running at http://localhost:${PORT}`))