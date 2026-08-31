import assert from 'node:assert/strict';
import test from 'node:test';

import { sourceAuthorityForClaims } from './sourcePolicy.js';

test('recognizes known official subdomains independently of claim strictness', () => {
  const claims = [{
    id: 'release', text: 'latest release', searchQueries: ['latest release'], preferredDomains: [],
    sourceTypes: [], subjectTerms: []
  }];

  assert.equal(sourceAuthorityForClaims(claims, 'https://docs.anthropic.com/en/release-notes'), 'official');
  assert.equal(sourceAuthorityForClaims(claims, 'https://platform.openai.com/docs/models/gpt-5'), 'official');
  assert.equal(sourceAuthorityForClaims(claims, 'https://roundup.example/openai'), 'unverified');
});
