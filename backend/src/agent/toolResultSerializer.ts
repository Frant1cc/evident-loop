type JsonRecord = Record<string, unknown>;

/**
 * Produces the model-facing representation of a tool result. The full result remains
 * available in the tool trace and persistence layer; this representation protects the
 * model context budget while preserving conclusions rather than an arbitrary prefix.
 */
export function serializeToolResultForModel(toolName: string, payload: unknown, maxChars: number): string {
  const modelPayload = toolName === 'retrieve_web_evidence' && isRecord(payload)
    ? compactWebRetrieval(payload)
    : payload;
  const serialized = JSON.stringify(modelPayload) ?? 'null';
  if (serialized.length <= maxChars) return serialized;

  if (toolName === 'retrieve_web_evidence' && isRecord(payload)) {
    const minimal = minimalWebRetrieval(payload);
    const compact = JSON.stringify(minimal);
    if (compact.length <= maxChars) return compact;
  }

  return validJsonPreview(serialized, maxChars);
}

function compactWebRetrieval(value: JsonRecord) {
  const claims = arrayRecords(value.claims);
  const sources = arrayRecords(value.sources);
  const diagnostics = isRecord(value.diagnostics) ? value.diagnostics : {};
  const evidenceEntities = arrayRecords(value.evidenceEntities);
  const requiredMentions = arrayRecords(value.requiredMentions);
  const conflicts = arrayRecords(value.conflicts);
  return {
    verdict: value.verdict,
    score: value.score,
    coverage: {
      covered: value.coveredClaimCount,
      total: value.totalClaimCount,
      score: value.coverageScore
    },
    claims: claims.map((claim) => ({
      id: claim.id,
      text: claim.text,
      supported: claim.supported,
      contradicted: claim.contradicted,
      score: claim.score,
      sourceUrls: stringArray(claim.sourceUrls).slice(0, 4),
      supportingEvidence: arrayRecords(claim.supportingEvidence).slice(0, 8).map(serializeClaimEvidence),
      contradictingEvidence: arrayRecords(claim.contradictingEvidence).slice(0, 4).map(serializeClaimEvidence)
    })),
    conflicts: conflicts.map((conflict) => ({
      claimId: conflict.claimId,
      claimText: conflict.claimText,
      status: conflict.status,
      reason: conflict.reason,
      highRisk: conflict.highRisk,
      requiresHumanReview: conflict.requiresHumanReview,
      supportingEvidence: arrayRecords(conflict.supportingEvidence).slice(0, 3).map(serializeConflictEvidence),
      contradictingEvidence: arrayRecords(conflict.contradictingEvidence).slice(0, 3).map(serializeConflictEvidence)
    })),
    uncoveredClaims: stringArray(value.uncoveredClaims),
    uncoveredBlockingClaims: stringArray(value.uncoveredBlockingClaims),
    evidenceEntities: evidenceEntities.map(serializeEvidenceEntity),
    requiredMentions: requiredMentions.map(serializeEvidenceEntity),
    sources: sources.map((source) => ({
      title: source.title,
      url: source.file,
      score: source.score
    })),
    diagnostics: {
      queriesUsed: diagnostics.queriesUsed,
      pagesFetched: diagnostics.pagesFetched,
      acceptedPages: diagnostics.acceptedPages,
      rejectedPages: diagnostics.rejectedPages,
      queryBudget: diagnostics.queryBudget,
      pageBudget: diagnostics.pageBudget,
      fetchAttemptBudget: diagnostics.fetchAttemptBudget,
      budgetExhaustedBy: diagnostics.budgetExhaustedBy,
      recoveryTriggered: diagnostics.recoveryTriggered,
      recoveryQueriesUsed: diagnostics.recoveryQueriesUsed,
      planningFailure: diagnostics.planningFailure,
      durationMs: diagnostics.durationMs,
      stopReason: diagnostics.stopReason,
      authorityRejectedUrls: diagnostics.authorityRejectedUrls,
      freshnessRejectedUrls: diagnostics.freshnessRejectedUrls,
      undatedThirdPartyUrls: diagnostics.undatedThirdPartyUrls
    }
  };
}

function minimalWebRetrieval(value: JsonRecord) {
  const diagnostics = isRecord(value.diagnostics) ? value.diagnostics : {};
  return {
    verdict: value.verdict,
    coverage: `${numberValue(value.coveredClaimCount)}/${numberValue(value.totalClaimCount)}`,
    claims: arrayRecords(value.claims).map((claim) => ({
      claim: shorten(String(claim.text ?? claim.id ?? ''), 140),
      supported: claim.supported === true,
      ...(claim.contradicted === true ? { contradicted: true } : {}),
      sourceUrls: stringArray(claim.sourceUrls).slice(0, 2),
      supportingEvidence: arrayRecords(claim.supportingEvidence).slice(0, 3).map((evidence) => ({
        url: evidence.url,
        quote: shorten(String(evidence.evidenceQuote ?? ''), 320)
      }))
    })),
    uncoveredClaims: stringArray(value.uncoveredClaims).map((claim) => shorten(claim, 140)),
    uncoveredBlockingClaims: stringArray(value.uncoveredBlockingClaims).map((claim) => shorten(claim, 140)),
    conflicts: arrayRecords(value.conflicts).map((conflict) => ({
      claim: shorten(String(conflict.claimText ?? conflict.claimId ?? ''), 140),
      status: conflict.status,
      requiresHumanReview: conflict.requiresHumanReview,
      supportUrl: firstEvidenceUrl(conflict.supportingEvidence),
      contradictUrl: firstEvidenceUrl(conflict.contradictingEvidence)
    })),
    requiredMentions: arrayRecords(value.requiredMentions).map(serializeEvidenceEntity),
    diagnostics: {
      budgetExhaustedBy: diagnostics.budgetExhaustedBy,
      recoveryTriggered: diagnostics.recoveryTriggered,
      recoveryQueriesUsed: diagnostics.recoveryQueriesUsed,
      planningFailure: diagnostics.planningFailure
    },
    stopReason: shorten(String(diagnostics.stopReason ?? ''), 240),
    note: 'Full tool result is stored separately; this is the context-budgeted evidence summary.'
  };
}

function serializeEvidenceEntity(entity: JsonRecord) {
  return {
    entity: entity.entity,
    aliases: stringArray(entity.aliases),
    claimIds: stringArray(entity.claimIds),
    sourceUrls: stringArray(entity.sourceUrls).slice(0, 4),
    evidencePatterns: stringArray(entity.evidencePatterns).slice(0, 4),
    directness: entity.directness,
    requiredMention: entity.requiredMention === true,
    ...(typeof entity.publishedAt === 'string' ? { publishedAt: entity.publishedAt } : {})
  };
}

function serializeConflictEvidence(evidence: JsonRecord) {
  return {
    url: evidence.url,
    authority: evidence.authority,
    confidence: evidence.confidence,
    evidenceQuote: shorten(String(evidence.evidenceQuote ?? ''), 300),
    ...(typeof evidence.publishedAt === 'string' ? { publishedAt: evidence.publishedAt } : {})
  };
}

function serializeClaimEvidence(evidence: JsonRecord) {
  return {
    url: evidence.url,
    quote: shorten(String(evidence.evidenceQuote ?? ''), 600),
    authority: evidence.authority,
    ...(typeof evidence.publishedAt === 'string' ? { publishedAt: evidence.publishedAt } : {})
  };
}

function firstEvidenceUrl(value: unknown) {
  const first = arrayRecords(value)[0];
  return typeof first?.url === 'string' ? first.url : undefined;
}

function validJsonPreview(serialized: string, maxChars: number) {
  const minimum = JSON.stringify({ truncated: true });
  if (maxChars <= minimum.length) return minimum.slice(0, Math.max(0, maxChars));
  let previewChars = Math.max(0, Math.floor((maxChars - 100) / 2));
  while (previewChars >= 0) {
    const candidate = JSON.stringify({
      truncated: true,
      originalChars: serialized.length,
      head: serialized.slice(0, previewChars),
      tail: serialized.slice(-previewChars)
    });
    if (candidate.length <= maxChars) return candidate;
    previewChars = Math.floor(previewChars * 0.8) - 1;
  }
  return minimum;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function arrayRecords(value: unknown) {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function numberValue(value: unknown) {
  return typeof value === 'number' ? value : 0;
}

function shorten(value: string, maxChars: number) {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`;
}
