/**
 * The bot's menu button, pointed at the current Mini App address, so a new tunnel needs no visit
 * to @BotFather. The token is used for the call and goes nowhere else: errors are reported by
 * Telegram's description only.
 */
import { Api, GrammyError } from 'grammy';

export type MenuButtonOutcome =
  { ok: true; label: string; keptLabel: boolean } | { ok: false; error: string };

/**
 * Sets the default menu button of private chats to open `url` as a web app. It keeps the label
 * of the button that is there; `fallbackLabel` is used when there is no web-app button yet.
 */
export async function updateMenuButton(input: {
  token: string;
  url: string;
  fallbackLabel: string;
  /** Tests point this at a fake Bot API. */
  apiRoot?: string;
}): Promise<MenuButtonOutcome> {
  const api = new Api(input.token, input.apiRoot ? { apiRoot: input.apiRoot } : {});
  try {
    const current = await api.getChatMenuButton();
    const keptLabel = current.type === 'web_app' && current.text.trim() !== '';
    const label = keptLabel && current.type === 'web_app' ? current.text : input.fallbackLabel;
    await api.setChatMenuButton({
      menu_button: { type: 'web_app', text: label, web_app: { url: input.url } },
    });
    return { ok: true, label, keptLabel };
  } catch (error) {
    if (error instanceof GrammyError) return { ok: false, error: error.description };
    return { ok: false, error: 'the Bot API could not be reached' };
  }
}
