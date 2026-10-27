import * as comeet from './comeet.mjs';
import * as lever from './lever.mjs';
import * as greenhouse from './greenhouse.mjs';
import * as ashby from './ashby.mjs';
import * as drushim from './drushim.mjs';
import * as alljobs from './alljobs.mjs';
import * as smartrecruiters from './smartrecruiters.mjs';
import * as workable from './workable.mjs';   // 26 Oct 2026, supply widening (discover: 3+ fitting roles)
import * as bamboohr from './bamboohr.mjs';   // 26 Oct 2026, same

// URL match first (the company's own site may embed Greenhouse / Comeet), then the card's ats name.
export const RECIPES = [comeet, lever, greenhouse, ashby, drushim, alljobs, smartrecruiters, workable, bamboohr];
export function recipeFor(card) {
  const url = card.apply && card.apply.url || '';
  return RECIPES.find(r => r.match(url)) || RECIPES.find(r => r.name === (card.apply && card.apply.ats)) || null;
}
export const recipeForUrl = url => RECIPES.find(r => r.match(url || '')) || null;
