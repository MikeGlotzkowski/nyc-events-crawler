import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { nonEventReason, decodeEntities } from './event-filter.js';

// Real titles/descriptions from prod (2026-10-01).
const hidden = [
  ['High School Football Games Coverage Poll', '', 'poll'],
  ['Staten Island Oktoberfest', 'Staten Island Oktoberfest has been postponed due to a forecasted nor’easter expected to impact the area.', 'cancelled'],
  ['[CANCELED] PlacePartner Opportunity: The Sweet Spot at W 72nd-96th St', '', 'cancelled'],
  ['Sweet Spot', '[OCT 14 EVENT CANCELED] Volunteer in the sweet spot of Riverside Park!', 'cancelled'],
  ['PlacePartner Opportunity: Canopy Club at W 97th-120th St', '', 'volunteer_shift'],
  ['Team RIVER Volunteers', '', 'volunteer_shift'],
  ['Café Alon Opening', '', 'business_opening'],
  ['Opening of Etihad Park', '', 'business_opening'],
  ['Café des Artistes Reopening', '', 'business_opening'],
  ['CHAP Voucher Program Applications Open', '', 'application_window'],
  ['Citywide Minority- and Women-Owned Business Accelerator Application', '', 'application_window'],
  ['Registration for Major AI Developers', '', 'application_window'],
  ['Click to Cancel Rule Implementation', '', 'policy_news'],
  ['November Ballot Vote', '', 'policy_news'],
];

const kept = [
  ['Atlantic Antic', 'Brooklyn’s largest street fair has been postponed from Sunday to Oct. 4, from 12 p.m. to 6 p.m.'],
  ['Bushwick Film Festival Opening Night', ''],
  ['Gallery Opening', ''],
  ['Grand Opening Block Party', ''],
  ['Summer on the Hudson: Sketch Jam', ''],
  ['Pollinator Walk', ''],
  ['Wild Oyster Survey', ''],
  ['Audition Prep Workshop', ''],
  ['Charlotte Mayerson&#8217;s Overlook Concerts', ''],
];

describe('nonEventReason', () => {
  for (const [title, description, reason] of hidden) {
    it(`hides "${title}" as ${reason}`, () => assert.equal(nonEventReason({ title, description }), reason));
  }
  for (const [title, description] of kept) {
    it(`keeps "${title}"`, () => assert.equal(nonEventReason({ title, description }), null));
  }
  it('handles missing fields', () => assert.equal(nonEventReason({}), null));
});

describe('decodeEntities', () => {
  it('decodes WordPress entities', () => {
    assert.equal(decodeEntities('It&#8217;s a Shore Thing &#8211; W 68th &#038; Riverside'), "It's a Shore Thing - W 68th & Riverside");
  });
});
