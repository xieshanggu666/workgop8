<script setup>
import { ref, computed } from 'vue'
import { useParkStore } from '@/store/park'

const store = useParkStore()
const typeFilter = ref('all')
const zoneFilter = ref(0)
const buildOpen = ref(false)
const build = ref({ type: '过山车', zone_id: 1, name: '' })

const types = ['过山车', '旋转木马', '摩天轮', '跳楼机', '碰碰车', '海盗船', '水上漂流', '云霄飞车']
const typeIcon = t => ({ '过山车':'🎢', '旋转木马':'🎠', '摩天轮':'🎡', '跳楼机':'🪂', '碰碰车':'🚗', '海盗船':'⛵', '水上漂流':'💦', '云霄飞车':'🚀' }[t])

const list = computed(() => store.rides.filter(r =>
  (typeFilter.value === 'all' || r.type === typeFilter.value) &&
  (!zoneFilter.value || r.zone_id === zoneFilter.value)
))

function update(r, payload) { store.updateRide(r.id, payload) }
function submit() {
  store.buildRide({ ...build.value, name: build.value.name || `${build.value.type}·新馆` })
  buildOpen.value = false
  build.value.name = ''
}
</script>

<template>
  <div class="rides">
    <div class="bar">
      <div class="filters">
        <select v-model="typeFilter"><option value="all">全部类型</option><option v-for="t in types" :key="t" :value="t">{{ t }}</option></select>
        <select v-model="zoneFilter"><option :value="0">全部区域</option><option v-for="z in store.zones" :key="z.id" :value="z.id">{{ z.name }}</option></select>
      </div>
      <button class="primary" @click="buildOpen = true">＋ 新建设施</button>
    </div>

    <div class="table card">
      <div class="thead">
        <span>设施</span><span>类型</span><span>区域</span><span>状态</span><span>健康度</span><span>刺激度</span><span>票价</span><span>累计营收</span><span>操作</span>
      </div>
      <div class="trow" v-for="r in list" :key="r.id">
        <span><b>{{ r.name }}</b><em class="muted">{{ r.type }}</em></span>
        <span>{{ typeIcon(r.type) }}</span>
        <span>{{ store.zones.find(z=>z.id===r.zone_id)?.name }}</span>
        <span><i class="dot" :class="r.status"></i>{{ r.status === 'operating' ? '运营' : r.status === 'maintenance' ? '检修' : '关闭' }}</span>
        <span><div class="hb"><i :style="{width:r.health+'%', background: r.health>60?'var(--green)':r.health>40?'var(--accent2)':'var(--red)'}"></i></div>{{ r.health }}</span>
        <span>{{ r.thrill }}</span>
        <span class="money">{{ r.price }}</span>
        <span class="money">{{ r.rev.toLocaleString() }}</span>
        <span class="ops">
          <button class="ghost" @click="r.status==='operating'?update(r,{status:'closed'}):update(r,{status:'operating'})">{{ r.status==='operating'?'关闭':'开放' }}</button>
          <button class="ghost" v-if="r.status!=='operating'" @click="update(r,{repair:1})">检修</button>
          <button class="ghost" @click="update(r,{upgrade:10})">升级</button>
          <button class="ghost danger" @click="store.delRide(r.id)">拆除</button>
        </span>
      </div>
    </div>

    <div class="modal" v-if="buildOpen">
      <div class="modal-box card">
        <h3>🏗️ 新建设施</h3>
        <div class="form">
          <label>设施类型
            <select v-model="build.type"><option v-for="t in types" :key="t" :value="t">{{ t }}</option></select>
          </label>
          <label>所属区域
            <select v-model.number="build.zone_id"><option v-for="z in store.zones.filter(z=>z.unlocked)" :key="z.id" :value="z.id">{{ z.name }}</option></select>
          </label>
          <label>名称 <input v-model="build.name" placeholder="留空自动命名" /></label>
        </div>
        <div class="acts">
          <button class="primary" @click="submit">确认建造</button>
          <button class="ghost" @click="buildOpen=false">取消</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.rides { display: flex; flex-direction: column; gap: 14px; }
.bar { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; }
.filters { display: flex; gap: 8px; }
.table { padding: 6px; overflow-x: auto; }
.thead, .trow { display: grid; grid-template-columns: 1.6fr .5fr .8fr .7fr 1fr .6fr .6fr .9fr 2fr; gap: 8px; align-items: center; padding: 10px 12px; font-size: 13px; min-width: 900px; }
.thead { color: var(--muted); border-bottom: 1px solid var(--border); font-size: 12px; }
.trow { border-bottom: 1px solid var(--border); }
.trow:last-child { border-bottom: none; }
.trow b { display: block; }
.trow em { font-style: normal; font-size: 11px; }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 5px; }
.dot.operating { background: var(--green); }
.dot.maintenance { background: var(--accent2); }
.dot.closed { background: var(--red); }
.hb { width: 90px; height: 7px; background: var(--panel2); border-radius: 4px; overflow: hidden; display: inline-block; margin-right: 6px; vertical-align: middle; }
.hb i { display: block; height: 100%; }
.ops { display: flex; gap: 4px; flex-wrap: wrap; }
.ops button { font-size: 11px; padding: 4px 8px; }
.modal { position: fixed; inset: 0; background: rgba(0,0,0,.55); display: flex; align-items: center; justify-content: center; z-index: 50; }
.modal-box { width: min(420px, 92vw); }
.form { display: flex; flex-direction: column; gap: 10px; margin: 14px 0; }
.form label { display: flex; flex-direction: column; gap: 5px; font-size: 13px; color: var(--muted); }
.acts { display: flex; gap: 8px; }
</style>