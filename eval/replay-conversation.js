'use strict';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error('Missing environment variable: ' + name);
  return value;
}

async function jsonFetch(url, options = {}) {
  const res = await fetch(url, options);
  let body = null;
  try { body = await res.json(); } catch (_) {}
  if (!res.ok) throw new Error((options.method || 'GET') + ' ' + url + ' -> ' + res.status + ': ' + JSON.stringify(body));
  return body;
}

async function main() {
  const baseUrl = required('B2BASE_REPLAY_URL').replace(/\/$/, '');
  const campaignId = required('B2BASE_REPLAY_CAMPAIGN_ID');
  const orgId = process.env.B2BASE_REPLAY_ORG_ID || 'eval-org';

  const historyBody = await jsonFetch(baseUrl + '/api/studio/campaigns/' + encodeURIComponent(campaignId) + '/chat', {
    headers: { 'x-test-org-id': orgId }
  });
  const history = Array.isArray(historyBody?.data) ? historyBody.data : [];
  const userTurns = history.filter((m) => m.role === 'user').map((m) => m.text).filter(Boolean);
  if (!userTurns.length) throw new Error('No user turns found in campaign conversation');

  const state = await jsonFetch(baseUrl + '/api/studio/campaigns/' + encodeURIComponent(campaignId) + '/state', {
    headers: { 'x-test-org-id': orgId }
  });
  const source = state?.data?.campaign || {};
  const created = await jsonFetch(baseUrl + '/api/studio/campaigns', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-test-org-id': orgId },
    body: JSON.stringify({
      name: 'Replay ' + (source.name || campaignId),
      channels: Array.isArray(source.channels) ? source.channels : ['email'],
    })
  });
  const replayCampaignId = created?.data?.id;
  if (!replayCampaignId) throw new Error('Replay campaign creation returned no id');

  const outputs = [];
  for (const message of userTurns) {
    const result = await jsonFetch(baseUrl + '/api/studio/campaigns/' + encodeURIComponent(replayCampaignId) + '/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-org-id': orgId },
      body: JSON.stringify({ message })
    });
    outputs.push({ message, result: result.data });
  }

  console.log(JSON.stringify({ sourceCampaignId: campaignId, replayCampaignId, turns: outputs }, null, 2));
}

main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });