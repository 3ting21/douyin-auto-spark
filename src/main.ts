import 'dotenv/config'
import { chromium, type Browser, type Cookie, type Locator, type Page } from 'playwright'
import { mkdir, readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import dayjs from 'dayjs'
import 'dayjs/locale/zh-cn'
import utc from 'dayjs/plugin/utc'
import timezone from 'dayjs/plugin/timezone'
import type { DouyinCookie, SameSite } from './types/douyin-cookie'
import type { Yiyan } from './types/yiyan'

dayjs.extend(utc)
dayjs.extend(timezone)
dayjs.locale('zh-cn')

const DOUYIN_ACCOUNTS_KEY = 'DOUYIN_ACCOUNTS'
const DOUYIN_ACCOUNTS_SHARD_PATTERN = /^DOUYIN_ACCOUNTS_(\d+)$/
const DOUYIN_COOKIE_KEY = 'DOUYIN_COOKIE'
const DOUYIN_TARGET_NAMES_KEY = 'DOUYIN_TARGET_NAMES'
const YIYAN_INCLUDE_SOURCE_KEY = 'YIYAN_INCLUDE_SOURCE'
const SPARK_MESSAGE_TEMPLATE_KEY = 'SPARK_MESSAGE_TEMPLATE'
const FAILURE_SCREENSHOT_DIRECTORY = 'artifacts'
const FIXED_SPARK_TARGET = '再睡三分钟'
const FIXED_SPARK_MESSAGE = '再睡三分钟，今天来续火花啦🔥 希望你今天开心顺利，记得好好休息呀！'

const CHAT_PAGE_READY_TIMEOUT = 30000
const CHAT_PAGE_IDLE_TIMEOUT = 10000
const SEARCH_RESULT_TIMEOUT = 5000
const SEARCH_RETRY_LIMIT = 3
const SEARCH_RETRY_INTERVAL = 2000
const SEARCH_INPUT_RESET_DELAY = 500
const MESSAGE_EDITOR_TIMEOUT = 15000
const MESSAGE_SEND_TIMEOUT = 15000
const MESSAGE_PERSISTENCE_TIMEOUT = 20000
const MESSAGE_POLL_INTERVAL = 250

const MESSAGE_TEMPLATE_PLACEHOLDER_PATTERN = /\{\{\s*([a-zA-Z]+)\s*\}\}/g
const MESSAGE_TEMPLATE_PLACEHOLDERS = [
  'account',
  'friend',
  'yiyan',
  'from',
  'date',
  'time',
  'weekday',
] as const

type MessageTemplatePlaceholder = (typeof MESSAGE_TEMPLATE_PLACEHOLDERS)[number]

interface DouyinAccount {
  name: string
  cookies: Cookie[]
  targetNames: string[]
  messageTemplate: string | undefined
}

/**
 * 启动本机 Chrome 浏览器并携带 Cookie 访问抖音聊天页。
 */
async function main(): Promise<void> {
  const browserPath = resolveBrowserPath()
  const headless = resolveHeadless()
  const autoClose = resolveAutoClose()
  const includeYiyanSource = resolveYiyanIncludeSource()
  const globalMessageTemplate = resolveSparkMessageTemplate()
  const accounts = resolveDouyinAccounts(globalMessageTemplate)
  const yiyans = await resolveYiyans()
  const browser = await chromium.launch({
    headless,
    ...(browserPath ? { executablePath: browserPath } : {}),
  })
  const failures: Error[] = []

  try {
    for (const account of accounts) {
      try {
        await runDouyinAccount(browser, account, yiyans, includeYiyanSource, autoClose)
      } catch (error) {
        const accountError = toError(error)
        failures.push(
          new Error(`[${account.name}] ${accountError.message}`, { cause: accountError }),
        )
        console.error(`账号执行失败：${account.name}`, accountError)
      }
    }

    if (!autoClose) {
      const readline = createInterface({
        input,
        output,
      })

      await readline.question('所有账号已执行完成，按回车键关闭浏览器...')
      readline.close()
    }

    if (failures.length > 0) {
      throw new AggregateError(failures, `${failures.length} 个抖音账号执行失败`)
    }
  } finally {
    // 无论任务是否失败，都关闭浏览器以释放 Playwright 持有的进程句柄。
    await browser.close()
  }
}

/**
 * 使用独立浏览器上下文执行一个抖音账号，避免不同账号的 Cookie 相互污染。
 *
 * @param browser Playwright 浏览器实例。
 * @param account 当前执行的抖音账号配置。
 * @param yiyans 可供消息模板使用的一言列表。
 * @param includeYiyanSource 默认消息是否包含一言出处。
 * @param autoClose 执行结束后是否自动关闭浏览器上下文。
 * @returns 账号执行完成后的 Promise。
 */
async function runDouyinAccount(
  browser: Browser,
  account: DouyinAccount,
  yiyans: Yiyan[],
  includeYiyanSource: boolean,
  autoClose: boolean,
): Promise<void> {
  const context = await browser.newContext()
  let page: Page | undefined

  try {
    console.log(`开始执行账号：${account.name}`)
    await context.addCookies(account.cookies)

    page = await context.newPage()
    await page.goto('https://www.douyin.com/chat', {
      waitUntil: 'domcontentloaded',
    })

    const searchInput = await findChatSearchInput(page)

    if (!searchInput) {
      throw new Error(await diagnoseChatPageUnavailable(page))
    }

    await waitForChatListReady(page, account.name)

    // 记录未命中的会话，等其余好友都发完再统一报错，避免一个人改名连累当天所有人。
    const missingNames: string[] = []
    const needsYiyan =
      account.messageTemplate === undefined ||
      /\{\{\s*(yiyan|from)\s*\}\}/.test(account.messageTemplate)

    for (const targetName of account.targetNames) {
      console.log(`[${account.name}] 开始搜索会话：${targetName}`)

      const searchResult = await searchConversation(page, searchInput, account.name, targetName)

      if (!searchResult) {
        await captureFailureScreenshot(page, `${account.name}-${targetName}-search`)
        console.log(`[${account.name}] 找不到搜索结果，已跳过：${targetName}`)
        missingNames.push(targetName)
        continue
      }

      await openConversation(page, searchResult, targetName)
      console.log(`[${account.name}] 已打开私信：${targetName}`)

      const editorInput = await findMessageEditor(page)

      let message: string

      if (targetName === FIXED_SPARK_TARGET) {
        message = FIXED_SPARK_MESSAGE
      } else if (account.messageTemplate !== undefined) {
        message = renderMessageTemplate(
          account.messageTemplate,
          account.name,
          targetName,
          needsYiyan ? pickRandomYiyan(yiyans) : undefined,
        )
      } else {
        const yiyan = pickRandomYiyan(yiyans)
        message = includeYiyanSource ? `${yiyan.hitokoto}\n——「${yiyan.from}」` : yiyan.hitokoto
      }

      await sendMessageWithFreshVerification(page, editorInput, message, account.name, targetName)
      console.log(`[${account.name}] 刷新聊天页后仍可看到新消息：${targetName}`)
    }

    await page.waitForTimeout(5000)

    if (missingNames.length > 0) {
      throw new Error(
        `以下会话未找到，火花可能已经中断：${missingNames.join('、')}。` +
          `好友改昵称是最常见的原因，建议在抖音中为好友设置备注名，` +
          `并把备注名填入账号的 targetNames，这样好友再改昵称也不会影响续火。`,
      )
    }

    console.log(`账号执行完成：${account.name}`)
  } catch (error) {
    await captureFailureScreenshot(page, account.name)
    throw error
  } finally {
    if (autoClose) {
      await context.close()
    }
  }
}

/**
 * 等待聊天页搜索框。抖音会灰度发布不同 DOM 结构，不能依赖单一 CSS 类名。
 */
async function findChatSearchInput(page: Page): Promise<Locator | undefined> {
  const candidates = [
    page.locator('input.semi-input[placeholder="搜索"]:visible'),
    page.locator('input[placeholder="搜索"]:visible'),
    page.locator('input[placeholder*="搜索"]:visible'),
    page.locator('input[aria-label*="搜索"]:visible'),
    page.locator('[role="searchbox"]:visible'),
    page.locator('input[type="search"]:visible'),
  ]
  const deadline = Date.now() + CHAT_PAGE_READY_TIMEOUT

  while (Date.now() < deadline) {
    for (const candidate of candidates) {
      const first = candidate.first()
      if (await first.isVisible().catch(() => false)) {
        return first
      }
    }

    await page.waitForTimeout(MESSAGE_POLL_INTERVAL)
  }

  return undefined
}

/**
 * 区分 Cookie 失效、抖音风控和页面结构变化，避免所有初始化失败都误报为 Cookie 问题。
 */
async function diagnoseChatPageUnavailable(page: Page): Promise<string> {
  const pageUrl = toSafePageUrl(page.url())
  const title = await page.title().catch(() => '')
  const bodyText = await page
    .locator('body')
    .innerText({ timeout: 5000 })
    .catch(() => '')
  const evidence = `${pageUrl}\n${title}\n${bodyText}`

  console.log(`聊天页诊断：URL=${pageUrl || '未知'}，标题=${title || '无'}`)

  if (
    /captcha|verify|安全验证|访问过于频繁|操作频繁|环境异常|请求异常|风险|滑块|网络异常/i.test(
      evidence,
    )
  ) {
    return (
      `聊天页被抖音安全验证或访问限制拦截（URL：${pageUrl || '未知'}，` +
      `标题：${title || '无'}）。GitHub Actions 的云端 IP 可能触发风控，请下载失败截图确认`
    )
  }

  if (/login|登录|扫码登录|验证码登录|手机号登录|密码登录/i.test(evidence)) {
    return (
      `抖音登录状态无效或已跳转到登录页（URL：${pageUrl || '未知'}，` +
      `标题：${title || '无'}）。请重新导出完整 Cookie 并更新 DOUYIN_COOKIE`
    )
  }

  if (!bodyText.trim()) {
    return (
      `抖音聊天页未渲染出内容（URL：${pageUrl || '未知'}，标题：${title || '无'}）。` +
      `页面资源可能被云端网络或风控拦截，请下载失败截图确认`
    )
  }

  return (
    `聊天页已打开但未找到搜索框（URL：${pageUrl || '未知'}，标题：${title || '无'}）。` +
    `可能是抖音页面结构发生变化，请下载失败截图确认`
  )
}

function toSafePageUrl(value: string): string {
  try {
    const url = new URL(value)
    return `${url.origin}${url.pathname}`
  } catch {
    return value.split('?')[0]?.split('#')[0] ?? ''
  }
}

/**
 * 打开搜索结果中的私信会话。
 * 抖音不同版本会把入口渲染成 button、div 或带 role 的元素，因此不依赖单一标签。
 */
async function openConversation(
  page: Page,
  searchResult: Locator,
  targetName: string,
): Promise<void> {
  const candidates = [
    searchResult.getByText(/^(发消息|发私信)$/).first(),
    searchResult.getByRole('button', { name: /发消息|发私信/ }).first(),
    searchResult
      .locator('[role="button"]')
      .filter({ hasText: /发消息|发私信/ })
      .first(),
  ]

  for (const candidate of candidates) {
    if (await candidate.isVisible().catch(() => false)) {
      await candidate.click({ timeout: 5000 })
      return
    }
  }

  throw new Error(`找到会话「${targetName}」，但未找到“发消息/发私信”入口`)
}

/**
 * 找到当前聊天窗口的消息编辑器。页面类名经常变化，优先使用语义属性，旧类名仅作兜底。
 */
async function findMessageEditor(page: Page): Promise<Locator> {
  const candidates = [
    page.locator(
      '.messageEditorimChatEditorContainer [data-slate-editor="true"][contenteditable="true"]',
    ),
    page.locator('[data-slate-editor="true"][contenteditable="true"]'),
    page.locator('[contenteditable="true"][role="textbox"]'),
    page.locator('textarea[placeholder*="消息"], textarea[placeholder*="输入"]'),
    page.locator('[contenteditable="true"]'),
  ]
  const deadline = Date.now() + MESSAGE_EDITOR_TIMEOUT

  while (Date.now() < deadline) {
    for (const candidate of candidates) {
      const first = candidate.first()
      if (await first.isVisible().catch(() => false)) {
        return first
      }
    }
    await page.waitForTimeout(MESSAGE_POLL_INTERVAL)
  }

  throw new Error('私信编辑框未出现，可能未成功打开聊天窗口')
}

/**
 * 写入消息并确认编辑器确实收到了输入事件。
 * 仅调用 keyboard.insertText 不一定会触发抖音编辑器的状态更新，导致发送按钮仍不可用。
 */
async function fillMessageEditor(editor: Locator, message: string): Promise<void> {
  await editor.click()

  try {
    await editor.fill(message)
  } catch {
    // 某些旧版 Slate 编辑器不支持 fill，退回到真实键盘输入。
    await editor.press('ControlOrMeta+A')
    await editor.press('Backspace')
    await editor.page().keyboard.insertText(message)
  }

  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    const currentText = await readEditorText(editor)
    if (messageTextMatches(currentText, message)) {
      return
    }
    await editor.page().waitForTimeout(MESSAGE_POLL_INTERVAL)
  }

  throw new Error('消息已尝试写入，但编辑框内容未更新；请检查抖音页面是否仍为聊天窗口')
}

/**
 * 点击发送按钮（若当前版本没有按钮则使用 Enter）并等待编辑框清空。
 * 这只说明本页提交了消息，不代表服务器已保存。
 */
async function submitMessage(page: Page, editor: Locator, targetName: string): Promise<void> {
  const sendButton = await findSendButton(page)

  if (sendButton && (await sendButton.isEnabled().catch(() => false))) {
    await sendButton.scrollIntoViewIfNeeded()
    await sendButton.click({ timeout: 5000 })
  } else {
    // 抖音部分版本隐藏发送按钮，Enter 是官方聊天编辑器的发送快捷键。
    await editor.press('Enter')
  }

  const deadline = Date.now() + MESSAGE_SEND_TIMEOUT
  while (Date.now() < deadline) {
    const editorText = await readEditorText(editor)

    if (!normalizeMessageText(editorText)) {
      return
    }

    await page.waitForTimeout(MESSAGE_POLL_INTERVAL)
  }

  throw new Error(`提交消息后编辑框未清空：${targetName}。发送按钮可能未生效`)
}

/**
 * 刷新当前已登录的聊天页，对比发送前后的记录数量。
 * 这可排除仅在当前页面短暂回显的消息，但不能证明对方已收到。
 */
async function sendMessageWithFreshVerification(
  page: Page,
  editor: Locator,
  message: string,
  accountName: string,
  targetName: string,
): Promise<void> {
  const countBeforeSend = await countVisibleMessageText(page, message)

  await fillMessageEditor(editor, message)
  await submitMessage(page, editor, targetName)
  console.log(`[${accountName}] 页面已提交消息，正在刷新聊天页核验：${targetName}`)

  try {
    // 编辑框清空可能早于发送请求完成，避免立即刷新中断请求。
    await page.waitForLoadState('networkidle', { timeout: CHAT_PAGE_IDLE_TIMEOUT }).catch(() => {})
    await page.reload({ waitUntil: 'domcontentloaded' })
    await openChatForVerification(page, accountName, targetName)

    const deadline = Date.now() + MESSAGE_PERSISTENCE_TIMEOUT
    while (Date.now() < deadline) {
      if ((await countVisibleMessageText(page, message)) > countBeforeSend) {
        return
      }
      await page.waitForTimeout(MESSAGE_POLL_INTERVAL)
    }

    throw new Error(
      `刷新聊天页后未看到新消息：${targetName}。消息可能未保存，请核对聊天记录后再决定是否重试`,
    )
  } catch (error) {
    await captureFailureScreenshot(page, `${accountName}-${targetName}-verification`)
    throw error
  }
}

async function openChatForVerification(
  page: Page,
  accountName: string,
  targetName: string,
): Promise<void> {
  const searchInput = await findChatSearchInput(page)
  if (!searchInput) {
    throw new Error(`刷新后无法加载聊天页：${await diagnoseChatPageUnavailable(page)}`)
  }

  await waitForChatListReady(page, accountName)
  const searchResult = await searchConversation(page, searchInput, accountName, targetName)
  if (!searchResult) {
    throw new Error(`刷新后找不到好友：${targetName}`)
  }

  await openConversation(page, searchResult, targetName)
  await findMessageEditor(page)
}

async function findSendButton(page: Page): Promise<Locator | undefined> {
  const candidates = [
    page.getByRole('button', { name: /^\s*发送\s*$/ }).last(),
    page
      .locator('button')
      .filter({ hasText: /^\s*发送\s*$/ })
      .last(),
    page
      .locator('[role="button"]')
      .filter({ hasText: /^\s*发送\s*$/ })
      .last(),
    page.locator('[aria-label*="发送"], [title*="发送"], [data-e2e*="send"]:visible').last(),
  ]

  for (const candidate of candidates) {
    if (await candidate.isVisible().catch(() => false)) {
      return candidate
    }
  }

  return undefined
}

async function readEditorText(editor: Locator): Promise<string> {
  return editor.evaluate((element) => {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      return element.value
    }
    return (element as HTMLElement).innerText || element.textContent || ''
  })
}

function normalizeMessageText(value: string): string {
  return value
    .replace(/\u200b/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\u00a0/g, ' ')
    .trim()
}

function messageTextMatches(actual: string, expected: string): boolean {
  const normalizedActual = normalizeMessageText(actual)
  const normalizedExpected = normalizeMessageText(expected)
  return Boolean(normalizedExpected) && normalizedActual.includes(normalizedExpected)
}

async function countVisibleMessageText(page: Page, message: string): Promise<number> {
  const matches = page.getByText(message, { exact: true })
  const count = await matches.count()
  let visibleCount = 0

  for (let index = 0; index < count; index += 1) {
    if (
      await matches
        .nth(index)
        .isVisible()
        .catch(() => false)
    ) {
      visibleCount += 1
    }
  }

  return visibleCount
}

/**
 * 等待会话列表真正渲染出数据再开始搜索。
 *
 * 搜索框会先于会话列表渲染，若此时就输入关键词，抖音的搜索索引尚未就绪，
 * 结果面板会一直为空，导致好友被误判成「改名了」。
 *
 * @param page 当前账号的聊天页。
 * @param accountName 账号名称，仅用于日志。
 * @returns 等待结束后的 Promise，超时也不抛错，交给后续搜索重试兜底。
 */
async function waitForChatListReady(page: Page, accountName: string): Promise<void> {
  const conversationListReady = await page
    .locator('[class*="conversation"], [class*="Conversation"]')
    .first()
    .waitFor({ state: 'visible', timeout: CHAT_PAGE_READY_TIMEOUT })
    .then(() => true)
    .catch(() => false)

  if (!conversationListReady) {
    console.log(`[${accountName}] 会话列表未在预期时间内出现，将依赖搜索重试兜底`)
  }

  // 会话列表的头像与最近消息还会继续拉取，等网络安静下来搜索命中率更高。
  await page.waitForLoadState('networkidle', { timeout: CHAT_PAGE_IDLE_TIMEOUT }).catch(() => {})
}

/**
 * 带重试地搜索会话，避免把「数据还没加载好」误判成「好友改了昵称」。
 *
 * 每一轮都重新清空输入框并等待旧结果消失，防止上一个好友的残留结果被当成命中。
 *
 * @param page 当前账号的聊天页。
 * @param searchInput 聊天页左侧的搜索输入框。
 * @param accountName 账号名称，仅用于日志。
 * @param targetName 需要搜索的好友昵称或备注名。
 * @returns 命中的搜索结果项，全部重试都没命中时返回 undefined。
 */
async function searchConversation(
  page: Page,
  searchInput: Locator,
  accountName: string,
  targetName: string,
): Promise<Locator | undefined> {
  const searchResult = page
    .locator('.SearchPanelitembox')
    .filter({
      has: page.getByText(targetName, { exact: true }),
    })
    .first()

  for (let attempt = 1; attempt <= SEARCH_RETRY_LIMIT; attempt += 1) {
    await searchInput.fill('')
    // 等旧的结果面板收起，否则会读到上一个好友残留的列表项。
    await page
      .locator('.SearchPanelitembox')
      .first()
      .waitFor({ state: 'hidden', timeout: SEARCH_RESULT_TIMEOUT })
      .catch(() => {})
    await page.waitForTimeout(SEARCH_INPUT_RESET_DELAY)
    await searchInput.fill(targetName)

    const searchResultVisible = await searchResult
      .waitFor({ state: 'visible', timeout: SEARCH_RESULT_TIMEOUT })
      .then(() => true)
      .catch(() => false)

    if (searchResultVisible) {
      return searchResult
    }

    if (attempt < SEARCH_RETRY_LIMIT) {
      console.log(
        `[${accountName}] 第 ${attempt} 次搜索未命中，${SEARCH_RETRY_INTERVAL} 毫秒后重试：${targetName}`,
      )
      await page.waitForTimeout(SEARCH_RETRY_INTERVAL)
    }
  }

  return undefined
}

/**
 * 在页面仍可访问时保存失败现场，且不让截图错误覆盖原始任务异常。
 */
async function captureFailureScreenshot(
  page: Page | undefined,
  accountName: string,
): Promise<void> {
  if (!page || page.isClosed()) {
    return
  }

  try {
    await mkdir(FAILURE_SCREENSHOT_DIRECTORY, { recursive: true })
    const screenshotPath = `${FAILURE_SCREENSHOT_DIRECTORY}/failure-screenshot-${toSafeFileName(accountName)}.png`
    await page.screenshot({
      path: screenshotPath,
      fullPage: true,
    })
    console.log(`已保存失败截图：${screenshotPath}`)
  } catch (error) {
    console.error('保存失败截图失败:', error)
  }
}

function toSafeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]+/g, '-').replace(/^-+|-+$/g, '') || 'account'
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/**
 * 解析 Playwright 可选的浏览器启动路径。
 */
function resolveBrowserPath(): string | undefined {
  const browserPathFromEnv = process.env.PLAYWRIGHT_BROWSER_PATH?.trim()

  if (browserPathFromEnv) {
    return browserPathFromEnv
  }

  return undefined
}

/**
 * 解析 Playwright 是否使用无头模式。
 */
function resolveHeadless(): boolean {
  const headless = process.env.PLAYWRIGHT_HEADLESS?.trim().toLowerCase()

  if (!headless) {
    return true
  }

  if (headless === 'true') {
    return true
  }

  if (headless === 'false') {
    return false
  }

  throw new Error('PLAYWRIGHT_HEADLESS 只能配置为 true 或 false')
}

/**
 * 解析脚本结束后是否自动关闭浏览器。
 */
function resolveAutoClose(): boolean {
  const autoClose = process.env.AUTO_CLOSE?.trim().toLowerCase()

  if (!autoClose) {
    return true
  }

  if (autoClose === 'true') {
    return true
  }

  if (autoClose === 'false') {
    return false
  }

  throw new Error('AUTO_CLOSE 只能配置为 true 或 false')
}

/**
 * 解析发送一言时是否携带出处。
 */
function resolveYiyanIncludeSource(): boolean {
  const includeSource = process.env[YIYAN_INCLUDE_SOURCE_KEY]?.trim().toLowerCase()

  if (!includeSource || includeSource === 'true') {
    return true
  }

  if (includeSource === 'false') {
    return false
  }

  throw new Error(`${YIYAN_INCLUDE_SOURCE_KEY} 只能配置为 true 或 false`)
}

/**
 * 解析自定义火花消息模板，未配置时返回 undefined 以沿用默认的一言格式。
 */
function resolveSparkMessageTemplate(): string | undefined {
  const template = process.env[SPARK_MESSAGE_TEMPLATE_KEY]?.trim()

  if (!template) {
    return undefined
  }

  return normalizeMessageTemplate(template, SPARK_MESSAGE_TEMPLATE_KEY)
}

/**
 * 校验并标准化消息模板。
 */
function normalizeMessageTemplate(template: string, sourceName: string): string {
  // 启动时就校验占位符，避免把写错的 {{xxx}} 原样发给好友。
  const unknownPlaceholders = [
    ...new Set(
      [...template.matchAll(MESSAGE_TEMPLATE_PLACEHOLDER_PATTERN)]
        .map((match) => match[1])
        .filter(
          (name) => !MESSAGE_TEMPLATE_PLACEHOLDERS.includes(name as MessageTemplatePlaceholder),
        ),
    ),
  ]

  if (unknownPlaceholders.length > 0) {
    throw new Error(
      `${sourceName} 中存在未识别的占位符：${unknownPlaceholders
        .map((name) => `{{${name}}}`)
        .join(
          '、',
        )}。支持的占位符：${MESSAGE_TEMPLATE_PLACEHOLDERS.map((name) => `{{${name}}}`).join(' ')}`,
    )
  }

  // .env 中难以书写多行值，因此支持用字面 \n 表示换行。
  return template.replace(/\\n/g, '\n')
}

/**
 * 将消息模板渲染为实际发送的文本。
 */
function renderMessageTemplate(
  template: string,
  account: string,
  friend: string,
  yiyan: Yiyan | undefined,
): string {
  // 定时任务跑在 UTC 时区的 runner 上，日期占位符统一按上海时区计算。
  const now = dayjs().tz('Asia/Shanghai')
  const placeholderValues: Record<MessageTemplatePlaceholder, string> = {
    account,
    friend,
    yiyan: yiyan?.hitokoto ?? '',
    from: yiyan?.from ?? '',
    date: now.format('YYYY-MM-DD'),
    time: now.format('HH:mm'),
    weekday: now.format('dddd'),
  }

  return template.replace(MESSAGE_TEMPLATE_PLACEHOLDER_PATTERN, (_match, name: string) => {
    return placeholderValues[name as MessageTemplatePlaceholder] ?? ''
  })
}

/**
 * 解析多账号配置。支持历史变量 DOUYIN_ACCOUNTS 与按编号拆分的 DOUYIN_ACCOUNTS_N，
 * 所有存在的配置会按历史变量、分片编号升序合并；没有多账号配置时回退到单账号变量。
 */
function resolveDouyinAccounts(globalMessageTemplate: string | undefined): DouyinAccount[] {
  const accountSources = resolveDouyinAccountSources()

  if (accountSources.length === 0) {
    return [
      {
        name: '默认账号',
        cookies: resolveLegacyDouyinCookies(),
        targetNames: resolveLegacyDouyinTargetNames(),
        messageTemplate: globalMessageTemplate,
      },
    ]
  }

  const accountNames = new Set<string>()

  return accountSources.flatMap(({ sourceName, text }) => {
    const accountsValue = parseJson(text, sourceName)

    if (!Array.isArray(accountsValue) || accountsValue.length === 0) {
      throw new Error(`${sourceName} 必须是非空账号数组 JSON`)
    }

    return accountsValue.map((value, index) => {
      const accountSourceName = `${sourceName}[${index}]`

      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error(`${accountSourceName} 必须是账号对象`)
      }

      const accountValue = value as Record<string, unknown>
      const name = resolveAccountName(accountValue.name, accountSourceName)

      if (accountNames.has(name)) {
        throw new Error(`多账号配置中存在重复账号名称：${name}`)
      }
      accountNames.add(name)

      return {
        name,
        cookies: resolveCookieArray(accountValue.cookie, `${accountSourceName}.cookie`),
        targetNames: resolveTargetNameArray(
          accountValue.targetNames,
          `${accountSourceName}.targetNames`,
        ),
        messageTemplate: resolveAccountMessageTemplate(
          accountValue.messageTemplate,
          `${accountSourceName}.messageTemplate`,
          globalMessageTemplate,
        ),
      }
    })
  })
}

function resolveDouyinAccountSources(): Array<{ sourceName: string; text: string }> {
  const sources: Array<{ sourceName: string; text: string }> = []
  const legacyText = process.env[DOUYIN_ACCOUNTS_KEY]?.trim()

  if (legacyText) {
    sources.push({ sourceName: DOUYIN_ACCOUNTS_KEY, text: legacyText })
  }

  const shardSources: Array<{ index: number; sourceName: string; text: string }> = []

  for (const [sourceName, value] of Object.entries(process.env)) {
    const match = sourceName.match(DOUYIN_ACCOUNTS_SHARD_PATTERN)
    const text = value?.trim()

    if (!match || !text) {
      continue
    }

    shardSources.push({
      index: Number(match[1]),
      sourceName,
      text,
    })
  }

  shardSources.sort((left, right) => left.index - right.index)
  sources.push(...shardSources.map(({ sourceName, text }) => ({ sourceName, text })))

  return sources
}

function resolveAccountName(value: unknown, sourceName: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${sourceName}.name 必须是非空字符串`)
  }

  return value.trim()
}

function resolveAccountMessageTemplate(
  value: unknown,
  sourceName: string,
  globalMessageTemplate: string | undefined,
): string | undefined {
  if (value === undefined || value === null) {
    return globalMessageTemplate
  }

  if (typeof value !== 'string') {
    throw new Error(`${sourceName} 必须是字符串`)
  }

  const template = value.trim()
  return template ? normalizeMessageTemplate(template, sourceName) : globalMessageTemplate
}

/**
 * 解析单账号 Cookie 配置。
 */
function resolveLegacyDouyinCookies(): Cookie[] {
  const douyinCookieText = process.env[DOUYIN_COOKIE_KEY]?.trim()

  if (!douyinCookieText) {
    throw new Error(
      `请设置 ${DOUYIN_COOKIE_KEY} 和 ${DOUYIN_TARGET_NAMES_KEY}；多账号请使用 ${DOUYIN_ACCOUNTS_KEY}_1 等分片变量`,
    )
  }

  return resolveCookieArray(parseJson(douyinCookieText, DOUYIN_COOKIE_KEY), DOUYIN_COOKIE_KEY)
}

/**
 * 解析单账号会话名称配置。
 */
function resolveLegacyDouyinTargetNames(): string[] {
  const targetNamesText = process.env[DOUYIN_TARGET_NAMES_KEY]?.trim()

  if (!targetNamesText) {
    throw new Error(
      `请设置环境变量 ${DOUYIN_TARGET_NAMES_KEY}，或在 .env 中配置 ${DOUYIN_TARGET_NAMES_KEY}`,
    )
  }

  return resolveTargetNameArray(
    parseJson(targetNamesText, DOUYIN_TARGET_NAMES_KEY),
    DOUYIN_TARGET_NAMES_KEY,
  )
}

function resolveCookieArray(value: unknown, sourceName: string): Cookie[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${sourceName} 必须是非空 Cookie 数组`)
  }

  return (value as DouyinCookie[]).map(toPlaywrightCookie)
}

function resolveTargetNameArray(value: unknown, sourceName: string): string[] {
  const targetNames = value as unknown[]

  if (
    !Array.isArray(targetNames) ||
    targetNames.length === 0 ||
    targetNames.some((targetName) => typeof targetName !== 'string' || !targetName.trim())
  ) {
    throw new Error(`${sourceName} 必须是非空字符串数组`)
  }

  return targetNames.map((targetName) => (targetName as string).trim())
}

function parseJson(value: string, sourceName: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch (error) {
    throw new Error(`${sourceName} 不是有效的 JSON`, { cause: error })
  }
}

/**
 * 解析一言数据列表。
 */
async function resolveYiyans(): Promise<Yiyan[]> {
  const yiyanText = await readFile('assets/yiyan.json', 'utf8')
  const yiyans = JSON.parse(yiyanText) as Yiyan[]

  if (!Array.isArray(yiyans) || yiyans.length === 0) {
    throw new Error('assets/yiyan.json 必须是非空数组')
  }

  return yiyans
}

/**
 * 从一言数据中随机挑选一条。
 */
function pickRandomYiyan(yiyans: Yiyan[]): Yiyan {
  return yiyans[Math.floor(Math.random() * yiyans.length)]
}

/**
 * 将抖音 Cookie 数据转换为 Playwright Cookie 数据。
 */
function toPlaywrightCookie(cookie: DouyinCookie): Cookie {
  const playwrightCookie: Cookie = {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    expires: cookie.session ? -1 : (cookie.expirationDate ?? -1),
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    sameSite: toPlaywrightSameSite(cookie.sameSite),
  }

  return playwrightCookie
}

/**
 * 将抖音 Cookie 的 SameSite 值转换为 Playwright Cookie 值。
 */
function toPlaywrightSameSite(sameSite: SameSite | null): Cookie['sameSite'] {
  if (sameSite === 'no_restriction') {
    return 'None'
  }

  return 'Lax'
}

main().catch((error: unknown) => {
  console.error('启动 Chrome 访问抖音聊天页失败:', error)
  process.exitCode = 1
})
