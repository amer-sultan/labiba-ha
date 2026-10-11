// لبيبة – ولُبّ القول ما قالت لبيبة
import fs from 'fs'
import pino from 'pino'
import qrcode from 'qrcode-terminal'
import Anthropic from '@anthropic-ai/sdk'
import { google } from 'googleapis'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const B = require('@whiskeysockets/baileys')
const makeWASocket = B.default
const { useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = B

const opt = JSON.parse(fs.readFileSync('/data/options.json', 'utf8'))
const SHEET = opt.spreadsheet_id
const TAB_FLOCK = 'السجلات', TAB_BUILD = 'بناء العنابر', TAB_OUT = 'رسائل لبيبة', TAB_LOG = 'واتساب'
const PARTNERS = ['عامر', 'عمار', 'حسن', 'حلومة', 'زاهي']
const BUILD_ITEMS = ['حفريات وأرض','باطون وأساسات','حديد وهيكل','معدات (Ejoy الصين)','شحن وجمارك','كهربا','مي','تهوية وتبريد','عمال وتركيب','متفرقات']

const claude = new Anthropic({ apiKey: opt.anthropic_api_key })
const auth = new google.auth.GoogleAuth({ keyFile: opt.google_credentials_file, scopes: ['https://www.googleapis.com/auth/spreadsheets'] })
const sheets = google.sheets({ version: 'v4', auth })
const log = (...a) => console.log(new Date().toISOString(), ...a)

async function append(range, rows) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET, range, valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS', requestBody: { values: rows }
  })
}

const SYSTEM = `أنت "لبيبة"، مساعدة حسابات مزرعة دجاج لاحم (شركاء: ${PARTNERS.join('، ')}).
في حسابين:
1) "${TAB_FLOCK}": مصاريف دورة الدجاج الجارية (صيصان، علف، مي، كهربا، بيطري، أدوية، رواتب، نفوق، بيع…).
2) "${TAB_BUILD}": مصاريف بناء العنابر الجديدة. البند لازم يكون واحد من: ${BUILD_ITEMS.join('، ')}.
اقرأ الرسالة أو الصورة (فاتورة، صفحة دفتر…) وطلّع كل قيد مالي. إذا الرسالة مش عن مصاري أو كميات، رجّع entries فاضية و reply فاضي.
رجّع JSON فقط بهالشكل:
{"entries":[{"sheet":"${TAB_FLOCK}"|"${TAB_BUILD}","date":"YYYY-MM-DD","item":"","details":"","qty":null,"unit_price":null,"amount":null,"paid":null,"status":null,"payer":null,"note":""}],"reply":""}
- payer: واحد من الشركاء إذا مذكور مين دفع، وإلا null.
- paid: المبلغ اللي انتدفع فعلاً (بناء العنابر)؛ status: "مدفوع" أو "غير مدفوع" (دورة الدجاج).
- إذا التاريخ مش مذكور استعمل تاريخ اليوم.
- reply: تأكيد قصير جداً بالعامية الفلسطينية، أو سؤال واحد إذا في إشي ناقص (مثلاً مين دفع).`

async function analyze(text, image) {
  const content = []
  if (image) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image.toString('base64') } })
  content.push({ type: 'text', text: `تاريخ اليوم: ${new Date().toISOString().slice(0,10)}\nالرسالة: ${text || '(صورة بدون نص)'}` })
  const r = await claude.messages.create({ model: opt.model, max_tokens: 2000, system: SYSTEM, messages: [{ role: 'user', content }] })
  const raw = r.content.map(c => c.text || '').join('')
  const m = raw.match(/\{[\s\S]*\}/)
  return m ? JSON.parse(m[0]) : { entries: [], reply: '' }
}

async function save(entries) {
  const flock = [], build = []
  for (const e of entries) {
    if (e.sheet === TAB_BUILD)
      build.push([e.date, e.item, e.details, e.qty, e.unit_price, e.amount, e.paid, null, e.payer, e.note])
    else
      flock.push([e.date, e.item, e.details, e.qty, e.amount, e.status])
  }
  if (flock.length) await append(`'${TAB_FLOCK}'!A:F`, flock)
  if (build.length) await append(`'${TAB_BUILD}'!A:G`, build.map(r => r.slice(0, 7)))
    .then(() => fixBuildPayers(build))
}

// writes payer/note (I:J) next to the rows just appended, without touching the formula column H
async function fixBuildPayers(build) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET, range: `'${TAB_BUILD}'!A:A` })
  const last = (res.data.values || []).length
  const first = last - build.length + 1
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET, range: `'${TAB_BUILD}'!I${first}:J${last}`, valueInputOption: 'USER_ENTERED',
    requestBody: { values: build.map(r => [r[8] ?? '', r[9] ?? '']) }
  })
}

let groupIds = {}   // name -> jid
let groupNames = {} // jid -> name

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('/data/auth')
  const sock = makeWASocket({ auth: state, logger: pino({ level: 'warn' }), browser: ['Labiba', 'Chrome', '1.0'] })
  sock.ev.on('creds.update', saveCreds)

  if (!state.creds.registered && opt.phone_number) {
    setTimeout(async () => {
      const code = await sock.requestPairingCode(opt.phone_number.replace(/\D/g, ''))
      log('🔑 رمز الربط (Pairing code):', code)
    }, 3000)
  }

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr && !opt.phone_number) qrcode.generate(qr, { small: true })
    if (connection === 'open') {
      log('✅ لبيبة متصلة بالواتساب')
      const all = await sock.groupFetchAllParticipating()
      for (const g of Object.values(all)) {
        if (!opt.groups.length || opt.groups.includes(g.subject)) { groupIds[g.subject] = g.id; groupNames[g.id] = g.subject }
      }
      log('الجروبات:', Object.keys(groupIds).join(' | '))
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode
      if (code === DisconnectReason.loggedOut) { log('❌ انقطع الربط – لازم تربط من جديد'); fs.rmSync('/data/auth', { recursive: true, force: true }) }
      setTimeout(start, 5000)
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    for (const msg of messages) {
      try {
        const jid = msg.key.remoteJid
        if (!groupNames[jid] || msg.key.fromMe || !msg.message) continue
        const m = msg.message
        const text = m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || ''
        const image = m.imageMessage ? await downloadMediaMessage(msg, 'buffer', {}) : null
        await append(`'${TAB_LOG}'!A:D`, [[new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Jerusalem' }), groupNames[jid], msg.pushName || '', text || (image ? '[صورة]' : '')]])
        if (!text && !image) continue
        const out = await analyze(text, image)
        if (out.entries?.length) await save(out.entries)
        if (out.reply) await sock.sendMessage(jid, { text: out.reply }, { quoted: msg })
      } catch (e) { log('خطأ:', e.message) }
    }
  })

  // outbox: rows in "رسائل لبيبة" with status "جاهز" get sent
  clearInterval(globalThis.outbox)
  globalThis.outbox = setInterval(async () => {
    try {
      const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET, range: `'${TAB_OUT}'!A2:C` })
      const rows = res.data.values || []
      for (let i = 0; i < rows.length; i++) {
        const [text, group, status] = rows[i]
        if (!text || (status || '').trim() !== 'جاهز') continue
        const jid = groupIds[group || opt.default_group] || Object.values(groupIds)[0]
        if (!jid) continue
        await sock.sendMessage(jid, { text })
        await sheets.spreadsheets.values.update({ spreadsheetId: SHEET, range: `'${TAB_OUT}'!C${i + 2}`, valueInputOption: 'RAW', requestBody: { values: [[`انبعتت ${new Date().toISOString().slice(0,16)}`]] } })
      }
    } catch (e) { log('outbox:', e.message) }
  }, 60000)
}

start()
