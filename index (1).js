const BOT_TOKEN = '8916785661:AAGtamtShKFUssXTFE6qW-M6mqRauzt3tfM';
const TRANSLATION_API = 'https://api.mymemory.translated.net/get';

console.log(`Telegram bot token configured.`);

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

async function telegram(method, payload) {
  let response;
  try {
    response = await fetch(`${TELEGRAM_API}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new Error('Could not reach the Telegram API.');
  }
  const result = await response.json();
  if (!response.ok || !result.ok) {
    throw new Error(result.description || `Telegram ${method} request failed.`);
  }
  return result.result;
}

function splitForTranslation(text, maxLength = 450) {
  const chunks = [];
  let remaining = text.trim();
  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf(' ', maxLength);
    if (splitAt < maxLength / 2) splitAt = maxLength;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function splitForTelegram(text, maxLength = 3800) {
  const chunks = [];
  let remaining = text.trim();
  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf(' ', maxLength);
    if (splitAt < maxLength / 2) splitAt = maxLength;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function decodeHtmlEntities(text) {
  return text
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)), )
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

async function translateText(text, langpair) {
  const translatedChunks = [];
  for (const chunk of splitForTranslation(text)) {
    const query = new URLSearchParams({ q: chunk, langpair });
    const response = await fetch(`${TRANSLATION_API}?${query}`);
    if (!response.ok) {
      throw new Error(`Translation service returned HTTP ${response.status}.`);
    }
    const result = await response.json();
    const translated = result.responseData?.translatedText;
    if (!translated || result.responseStatus !== 200) {
      throw new Error('Translation service could not translate this message.');
    }
    translatedChunks.push(decodeHtmlEntities(translated));
  }
  return translatedChunks.join(' ');
}

async function sendTranslationsInComments(discussionTarget, arabic, persian) {
  const sections = [
    { label: 'العربية', text: arabic },
    { label: 'فارسی', text: persian },
  ];
  const combined = sections
    .map(({ label, text }) => `${label}:\n${text}`)
    .join('\n\n');

  if (combined.length <= 3900) {
    await telegram('sendMessage', {
      chat_id: discussionTarget.chatId,
      text: combined,
      reply_to_message_id: discussionTarget.messageId,
      disable_web_page_preview: true,
    });
    return;
  }

  const messages = sections.flatMap(({ label, text }) =>
    splitForTelegram(text).map((chunk, index) => `${index === 0 ? `${label}:\n` : ''}${chunk}`),
  );

  for (const text of messages) {
    await telegram('sendMessage', {
      chat_id: discussionTarget.chatId,
      text,
      reply_to_message_id: discussionTarget.messageId,
      disable_web_page_preview: true,
    });
  }
}

const discussionTargets = new Map();
const waitingDiscussionTargets = new Map();

function getAutomaticForwardOrigin(message) {
  if (!message.is_automatic_forward) return null;
  const origin = message.forward_origin;
  if (origin?.type === 'channel' && origin.chat?.id && origin.message_id) {
    return { chatId: origin.chat.id, messageId: origin.message_id };
  }
  const legacyChat = message.forward_from_chat;
  if (legacyChat?.type === 'channel' && message.forward_from_message_id) {
    return { chatId: legacyChat.id, messageId: message.forward_from_message_id };
  }
  return null;
}

function channelPostKey(chatId, messageId) {
  return `${chatId}:${messageId}`;
}

function captureDiscussionPost(message) {
  const origin = getAutomaticForwardOrigin(message);
  if (!origin) return;
  const key = channelPostKey(origin.chatId, origin.messageId);
  const target = { chatId: message.chat.id, messageId: message.message_id };
  const waiting = waitingDiscussionTargets.get(key);
  if (waiting) {
    clearTimeout(waiting.timer);
    waitingDiscussionTargets.delete(key);
    waiting.resolve(target);
    return;
  }
  const now = Date.now();
  for (const [cachedKey, entry] of discussionTargets) {
    if (entry.expiresAt <= now) discussionTargets.delete(cachedKey);
  }
  discussionTargets.set(key, { target, expiresAt: now + 5 * 60 * 1000 });
}

function waitForDiscussionPost(key, timeoutMs = 20000) {
  const cached = discussionTargets.get(key);
  if (cached) {
    discussionTargets.delete(key);
    if (cached.expiresAt > Date.now()) return Promise.resolve(cached.target);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waitingDiscussionTargets.delete(key);
      reject(new Error('No forwarded post appeared in the linked discussion group.'));
    }, timeoutMs);
    waitingDiscussionTargets.set(key, { timer, resolve });
  });
}

async function processChannelPost(message) {
  const text = message.text;
  if (!text?.trim() || message.from?.is_bot) return;
  try {
    const channel = await telegram('getChat', { chat_id: message.chat.id });
    const linkedChatId = channel.linked_chat_id;
    if (!linkedChatId) {
      throw new Error('This channel has no linked discussion group.');
    }
    const english = await translateText(text, 'ar|en');
    const persian = await translateText(english, 'en|fa');
    const key = channelPostKey(message.chat.id, message.message_id);
    const discussionTarget = await waitForDiscussionPost(key);
    if (String(discussionTarget.chatId) !== String(linkedChatId)) {
      throw new Error('The forwarded post came from an unexpected discussion group.');
    }
    await sendTranslationsInComments(discussionTarget, text, persian);
  } catch (error) {
    console.error(`Could not comment on channel post ${message.message_id}: ${error.message}`);
  }
}

async function run() {
  let offset = 0;
  const allowedUpdates = ['message', 'channel_post'];
  try {
    const pendingUpdates = await telegram('getUpdates', {
      offset: -1,
      timeout: 0,
      allowed_updates: allowedUpdates,
    });
    if (pendingUpdates.length > 0) {
      offset = pendingUpdates[pendingUpdates.length - 1].update_id + 1;
    }
  } catch (error) {
    console.error(`Could not clear old updates: ${error.message}`);
  }

  console.log('Telegram Arabic-Persian comments bot is running.');

  while (true) {
    try {
      const updates = await telegram('getUpdates', {
        offset,
        timeout: 50,
        allowed_updates: allowedUpdates,
      });
      for (const update of updates) {
        offset = update.update_id + 1;
        if (update.message) captureDiscussionPost(update.message);
        if (update.channel_post) {
          void processChannelPost(update.channel_post);
        }
      }
    } catch (error) {
      console.error(`Bot polling error: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

run();
