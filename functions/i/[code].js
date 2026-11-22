// Cloudflare Pages Function: invite links (https://japa-or-stay.pages.dev/i/CODE) with a link preview that describes
// the game and the challenge. Uses the same D1 binding (DB) as the Arena API.
import invite from '../../arena/server/invite-page.js';

export async function onRequestGet({ request, env }) {
  return invite.invitePage(request, env);
}
