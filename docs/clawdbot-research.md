# Исследование: Clawdbot (OpenClaw) vs Conciergon — форматирование Telegram-сообщений

## Контекст

Conciergon имеет проблемы с форматированием сообщений в Telegram: обратные слеши markdown протекают, форматирование выглядит некрасиво, сообщения не такие "сочные" как у Clawdbot. Это исследование сравнивает подходы двух проектов и выявляет конкретные улучшения для Conciergon.

---

## 1. РЕНДЕРИНГ TELEGRAM-СООБЩЕНИЙ

### Как делает Clawdbot (правильно)

**Ключевой подход: HTML parse_mode, а не MarkdownV2**

Clawdbot использует `parse_mode: "HTML"` как основной режим отправки. Это ПРИНЦИПИАЛЬНОЕ отличие от нашего подхода.

#### Архитектура рендеринга (3-ступенчатая):

```
Markdown текст → IR (Intermediate Representation) → HTML для Telegram
```

**Шаг 1: Парсинг в IR** (`src/markdown/ir.ts`)
- Используется библиотека `markdown-it` для парсинга
- Markdown конвертируется в промежуточное представление (IR):
  ```json
  {
    "text": "Hello world — see docs.",
    "styles": [{ "start": 6, "end": 11, "style": "bold" }],
    "links": [{ "start": 19, "end": 23, "href": "https://docs.openclaw.ai" }]
  }
  ```
- Поддерживаемые стили: `bold`, `italic`, `strikethrough`, `code`, `code_block`, `spoiler`, `blockquote`
- Позиции в UTF-16 code units (для совместимости с Signal)
- Токены обрабатываются рекурсивно через `renderTokens()`
- Стили управляются через open/close стек

**Шаг 2: Рендеринг в HTML** (`src/telegram/format.ts`)
- `renderTelegramHtml(ir)` конвертирует IR в Telegram HTML:
  - **bold** → `<b>...</b>`
  - **italic** → `<i>...</i>`
  - **strikethrough** → `<s>...</s>`
  - **code** → `<code>...</code>`
  - **code_block** → `<pre><code>...</code></pre>`
  - **spoiler** → `<tg-spoiler>...</tg-spoiler>`
  - **blockquote** → `<blockquote>...</blockquote>`
- HTML-эскейпинг: только `&`, `<`, `>` (функция `escapeHtml()`)
- Дополнительно `escapeHtmlAttr()` для атрибутов (кавычки)

**Шаг 3: Пост-обработка**
- `wrapFileReferencesInHtml()` — оборачивает "осиротевшие" имена файлов (типа `README.md`) в `<code>` чтобы Telegram не превращал их в ссылки
- `isAutoLinkedFileRef()` — детектирует ложные ссылки (markdown-it ошибочно линкует `.md`, `.go`, `.py` и т.д.)

**Шаг 4: Отправка с fallback**
```typescript
// Пробуем HTML → при ошибке парсинга отправляем plain text
withTelegramHtmlParseFallback({
  requestHtml: () => api.sendMessage(chatId, htmlText, { parse_mode: "HTML" }),
  requestPlain: () => api.sendMessage(chatId, plainText),
})
```

#### Главные экспорты `format.ts`:
| Функция | Назначение |
|---------|-----------|
| `markdownToTelegramHtml()` | Markdown строка → Telegram HTML |
| `markdownToTelegramChunks()` | Markdown → чанки с HTML |
| `markdownToTelegramHtmlChunks()` | Только HTML чанки |
| `renderTelegramHtmlText()` | Обработка как markdown так и HTML input |

#### Стриминг ответов (`src/telegram/draft-stream.ts`):
- Создаётся одно сообщение, потом **редактируется** через `editMessageText`
- Дебаунс первого сообщения (`minInitialChars`) чтобы не спамить push-уведомлениями
- Throttle минимум 250ms между обновлениями
- Максимум 4096 символов — при превышении стриминг останавливается
- `forceNewMessage()` для начала нового сообщения

#### Чанкинг (`src/telegram/draft-chunking.ts`):
- Дефолт: min 200 символов, max 800 символов (для стриминга)
- Break preference: `paragraph` > `newline` > `sentence`
- Чанкинг работает на уровне IR (до рендеринга!), что гарантирует целостность стилей
- Code fences — неделимые блоки при чанкинге

### Как делает Conciergon (проблемно)

**Подход: MarkdownV2 с каскадным fallback**

```typescript
// src/telegram/index.ts:270-287
// Попытка 1: MarkdownV2
// Попытка 2: Markdown (legacy)
// Попытка 3: plain text
```

#### Основные проблемы:

1. **MarkdownV2 — СЛОЖНЕЙШИЙ parse_mode**. Нужно эскейпить 20+ спецсимволов (`_ * [ ] ( ) ~ > # + - = | { } . !`), при этом НЕ эскейпить внутри code blocks. Это генерирует кучу `\` в тексте.

2. **Каскадный fallback MarkdownV2 → Markdown → plain text** означает:
   - Текст, подготовленный для MarkdownV2 (с `\` перед каждым спецсимволом), отправляется как Markdown — все бэкслеши видны
   - Или отправляется как plain text — вообще без форматирования
   - Пользователь видит "мусор" типа `\#`, `\.`, `\-` в сообщениях

3. **Двойной эскейпинг**: шаблоны в `messages.ts` эскейпят legacy Markdown (`` _ * ` [ ``), потом `sendMessage` пытается отправить как MarkdownV2 который требует ЕЩЁ БОЛЬШЕ эскейпинга

4. **Нет IR (промежуточного представления)**: текст просто прогоняется через regex-замены, без понимания структуры документа

5. **Чанкинг не учитывает форматирование**: `splitMessage()` режет по `\n\n` или `\n`, но не знает про code blocks и может разрезать блок кода пополам

---

## 2. СТРУКТУРА ПРОЕКТА CLAWDBOT

### Полная структура `src/` (45 директорий):
```
src/
├── acp/                  # Access Control Policies
├── agents/               # Агенты, system prompt, identity, tools (373 файла!)
│   ├── system-prompt.ts  # Сборка system prompt из секций
│   ├── identity.ts       # Загрузка и резолвинг identity агента
│   ├── identity-file.ts  # Парсинг файлов идентичности (SOUL.md)
│   ├── identity-avatar.ts
│   ├── model-catalog.ts  # Каталог моделей
│   ├── tool-policy.ts    # Политики инструментов
│   └── ...
├── auto-reply/           # Автоматическая маршрутизация ответов
├── browser/              # Браузерная автоматизация
├── canvas-host/          # Canvas rendering
├── channels/             # Общие абстракции каналов
├── cli/                  # CLI команды и прогресс
├── commands/             # Пользовательские команды
├── compat/               # Совместимость
├── config/               # Конфигурация
├── cron/                 # Планировщик задач
├── daemon/               # Daemon процесс
├── discord/              # Discord канал
├── docs/                 # Документация
├── gateway/              # Gateway сервер
├── hooks/                # Хуки событий
├── imessage/             # iMessage канал
├── infra/                # Инфраструктура
├── line/                 # LINE канал
├── link-understanding/   # Парсинг ссылок
├── logging/              # Логирование
├── macos/                # macOS специфика
├── markdown/             # Markdown парсинг и IR (14 файлов)
│   ├── ir.ts             # Intermediate Representation
│   ├── render.ts         # Рендерер с маркерами
│   ├── fences.ts         # Code fences
│   ├── code-spans.ts     # Inline code
│   ├── tables.ts         # Таблицы
│   ├── frontmatter.ts    # YAML frontmatter
│   └── whatsapp.ts       # WhatsApp-специфика
├── media/                # Медиа обработка
├── media-understanding/  # AI понимание медиа
├── memory/               # Память/контекст
├── node-host/            # Node.js хост
├── pairing/              # Device pairing
├── plugin-sdk/           # SDK для плагинов
├── plugins/              # Встроенные плагины
├── process/              # Процессы
├── providers/            # AI провайдеры
├── routing/              # Маршрутизация сообщений
├── scripts/              # Утилиты
├── security/             # Безопасность
├── sessions/             # Управление сессиями
├── shared/               # Общие утилиты
├── signal/               # Signal канал
├── slack/                # Slack канал
├── telegram/             # Telegram канал (78 файлов!)
│   ├── bot.ts            # Основной бот (grammY)
│   ├── send.ts           # Отправка сообщений (HTML mode!)
│   ├── format.ts         # Markdown → Telegram HTML конвертер
│   ├── draft-stream.ts   # Стриминг ответов (edit messages)
│   ├── draft-chunking.ts # Чанкинг для стриминга
│   ├── caption.ts        # Обработка подписей к медиа
│   ├── inline-buttons.ts # Инлайн-кнопки
│   ├── bot-message.ts    # Обработка входящих
│   ├── bot-message-dispatch.ts  # Отправка исходящих
│   ├── bot-message-context.ts   # Контекст сообщения
│   └── ...
├── terminal/             # Терминальный интерфейс
├── test-helpers/         # Тестовые утилиты
├── test-utils/           # Тестовые утилиты
├── tts/                  # Text-to-speech
├── tui/                  # TUI интерфейс
├── types/                # Общие типы
├── utils/                # Утилиты
├── web/                  # Веб-интерфейс
├── whatsapp/             # WhatsApp канал
└── wizard/               # Setup wizard
```

### Паттерн "inject" — как файлы инжектятся в контекст:

#### Identity Files (SOUL.md)
- `src/agents/identity-file.ts` загружает файлы вида:
  ```markdown
  - name: Luna
  - emoji: 🌙
  - creature: owl
  - vibe: calm and wise
  - theme: night sky
  - avatar: ./avatar.png
  ```
- Парсится из markdown (label: value формат)
- Имеет плейсхолдеры для незаполненных полей
- Аватары: workspace-relative path, HTTP URL, или data URI

#### System Prompt (`src/agents/system-prompt.ts`)
Собирается из секций через `buildAgentSystemPrompt()`:

| Секция | Содержание |
|--------|-----------|
| **Tooling** | Доступные инструменты с описаниями |
| **Tool Call Style** | Когда озвучивать действия |
| **Safety** | Правила безопасности |
| **Skills** | Инструкции по SKILL.md |
| **Memory Recall** | Memory search/get |
| **Workspace** | Рабочая директория |
| **User Identity** | Телефоны владельца |
| **Date & Time** | Таймзона |
| **Messaging** | Маршрутизация каналов |
| **Runtime** | Agent ID, OS, модель, shell |
| **Reactions** | Руководство по emoji |
| **Project Context** | Инжектированные файлы пользователя |
| **Heartbeats** | Паттерны пульса |

3 режима:
- `"full"` — полный промпт (основной агент)
- `"minimal"` — сокращённый (для субагентов)
- `"none"` — только базовая декларация

#### Context Files
- `contextFiles?: EmbeddedContextFile[]` — файлы инжектируются прямо в system prompt
- Поддержка `workspaceNotes` — заметки по проекту

---

## 3. КОНКРЕТНЫЕ ПРОБЛЕМЫ CONCIERGON И РЕШЕНИЯ

### Проблема 1: MarkdownV2 вместо HTML
**Симптомы**: обратные слеши (`\#`, `\.`, `\!`) протекают в сообщения
**Решение**: Перейти на `parse_mode: "HTML"` как Clawdbot

### Проблема 2: Нет IR (промежуточного представления)
**Симптомы**: регексы не могут правильно обработать вложенное форматирование
**Решение**: Внедрить markdown-it парсер → IR → HTML рендерер

### Проблема 3: Каскадный fallback отправляет подготовленный MarkdownV2 как plain text
**Симптомы**: пользователь видит `\*bold\*` вместо **bold**
**Решение**: HTML fallback — при ошибке парсинга HTML, отправить plain text (без бэкслешей)

### Проблема 4: Чанкинг разрезает code blocks
**Симптомы**: неправильное форматирование в длинных сообщениях
**Решение**: Чанкинг на уровне IR, code fences как неделимые блоки

### Проблема 5: Нет стриминга (typing indicator не информативен)
**Симптомы**: пользователь долго видит "typing..." без контента
**Решение**: Draft-stream паттерн — создать сообщение и редактировать его по мере генерации

### Проблема 6: Шаблоны в CLAUDE.md скучные и без форматирования
**Симптомы**: `Worker #3 completed. Result: ...` — сухо и без эмодзи
**Решение**: Использовать HTML теги в шаблонах, добавить эмодзи, структуру

---

## 4. РЕКОМЕНДУЕМЫЙ ПЛАН ДЕЙСТВИЙ (от наиболее к наименее критичному)

### Фаза 1: Переход на HTML parse_mode
**Файлы**: `src/telegram/index.ts`
- Заменить `parse_mode: "MarkdownV2"` на `parse_mode: "HTML"`
- Реализовать `escapeHtml()` (только `&`, `<`, `>`)
- Fallback: HTML → plain text (2 шага вместо 3)
- Обновить `sendMessage()`, `sendQuestionMessage()`

### Фаза 2: Создать Markdown → IR → HTML пайплайн
**Новые файлы**: `src/markdown/types.ts`, `src/markdown/ir.ts`, `src/markdown/chunking.ts`, `src/telegram/format.ts`
- Установить `markdown-it` (`npm i markdown-it @types/markdown-it`)
- IR: `MarkdownIR { text, styles[], links[] }` — канал-агностичное представление
- Рендерер: `IRRenderer` интерфейс с `styleMarkers`, `escapeText`, `buildLink`
- Telegram реализация: bold→`<b>`, italic→`<i>`, code→`<code>`, code_block→`<pre><code>`, strike→`<s>`
- Чанкинг на уровне IR, code fences неделимы

### Фаза 3: Обновить шаблоны сообщений
**Файл**: `src/manager/CLAUDE.md`
- Перевести шаблоны на HTML формат

### Фаза 4 (опционально): Draft streaming
- Реализовать паттерн edit-message для стриминга ответов worker'ов

---

## 5. СРАВНИТЕЛЬНАЯ ТАБЛИЦА

| Аспект | Clawdbot (OpenClaw) | Conciergon |
|--------|-------------------|------------|
| Parse mode | **HTML** | MarkdownV2 → Markdown → plain |
| Парсинг | markdown-it → IR → HTML | Regex escaping |
| Эскейпинг | `&`, `<`, `>` (3 символа) | 20+ спецсимволов MarkdownV2 |
| Fallback | HTML → plain text | MarkdownV2 → Markdown → plain (3 ступени, все ломают друг друга) |
| Стриминг | editMessage (live updates) | typing indicator только |
| Чанкинг | IR-level, code fences неделимы | Текстовый split по `\n\n`/`\n` |
| Шаблоны | Нет явных шаблонов, LLM генерирует | CLAUDE.md шаблоны (plain text) |
| Файлов в telegram/ | 78 | 1 (index.ts, 441 строк) |
| Code blocks | `<pre><code>` HTML | ` ``` ` MarkdownV2 |
| Inline buttons | Отдельный модуль `inline-buttons.ts` | Встроено в `sendQuestionMessage` |
| File refs | Auto-wrap в `<code>` | Нет обработки |
| Библиотека | grammY | grammY |

---

## 6. ИСТОЧНИКИ

- [clawdbot/clawdbot на GitHub](https://github.com/clawdbot/clawdbot)
- [DeepWiki: Channel Architecture](https://deepwiki.com/clawdbot/clawdbot/3.1-channel-architecture)
- [DeepWiki: Telegram Integration](https://deepwiki.com/openclaw/openclaw/8.3-telegram-integration)
- [OpenClaw Docs: Markdown Formatting](https://docs.openclaw.ai/concepts/markdown-formatting)
- [clawdbot на npm](https://www.npmjs.com/package/clawdbot)
- [AGENTS.md](https://github.com/clawdbot/clawdbot/blob/main/AGENTS.md)

### Исследованные файлы Clawdbot:
- `src/telegram/format.ts` — конвертер Markdown → Telegram HTML
- `src/telegram/send.ts` — отправка с HTML parse_mode + fallback
- `src/telegram/bot.ts` — grammY бот, handlers
- `src/telegram/draft-stream.ts` — стриминг через edit messages
- `src/telegram/draft-chunking.ts` — чанкинг для стриминга
- `src/markdown/ir.ts` — Intermediate Representation
- `src/markdown/render.ts` — рендерер с маркерами
- `src/agents/system-prompt.ts` — сборка system prompt
- `src/agents/identity.ts` — identity resolution
- `src/agents/identity-file.ts` — парсинг SOUL.md файлов

### Исследованные файлы Conciergon:
- `src/telegram/index.ts` — единственный файл Telegram (441 строк)
- `src/manager/messages.ts` — шаблонная система
- `src/manager/CLAUDE.md` — шаблоны сообщений
