// A game's share link (#229): a short link (the game kept on our server, src/net/shares.ts) when it can be had, else
// the long one with the whole record in it (replay.ts shareLink), which always works. Uploading sends the game to our
// server, so it needs Privacy & Terms accepted (#208) and a server; offline, or anything failing, gives the long link.
import type { GameRecord } from '../engine';
import { uploadShare } from '../net/shares';
import { hasAcceptedTerms } from './legal';
import { forSharing, sharedSummary, shareLink, shortLink } from './replay';
import { SITE } from './shareCard';
import type { StoredReview } from './store';

/** The link to share `rec` by, with its review (if it has one) going along for the short link. */
export async function gameLink(rec: GameRecord, review?: StoredReview): Promise<string> {
  if (hasAcceptedTerms()) {
    const code = await uploadShare(forSharing(rec), review ? sharedSummary(review) : undefined);
    if (code) return shortLink(code, SITE);
  }
  return shareLink(rec, SITE);
}
