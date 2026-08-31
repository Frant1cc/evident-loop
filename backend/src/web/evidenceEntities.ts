import type { WebClaim } from './claims.js';
import { isKnownOfficialUrl } from './sourcePolicy.js';

export type EvidenceDirectness = 'direct' | 'indirect';

export type EvidenceEntity = {
  entity: string;
  aliases: string[];
  claimIds: string[];
  sourceUrls: string[];
  evidencePatterns: string[];
  directness: EvidenceDirectness;
  requiredMention: boolean;
  publishedAt?: string;
};

export type PageEntityEvidence = EvidenceEntity & {
  exactEntityMatch: boolean;
  titleExactMatch: boolean;
  urlEntityMatch: boolean;
};

const releaseTitlePatterns = [
  /^(?:introducing|announcing)\s+(.+?)(?:\s+[|\\\-–—]\s*[^|\\]+)?$/iu,
  /^(.+?)\s+(?:launch|release)(?:\s+[|\\\-–—]\s*[^|\\]+)?$/iu
];

const releaseLinePatterns = [
  /^(?:introducing|announcing)\s+(.+?)$/gimu,
  /^(.+?)\s+(?:launch|release)$/gimu,
  /\bwe\s+(?:have\s+)?launched\s+([^.,;:\n]{2,120})/giu,
  /^(?:(?:今天|今日)\s*)?(?:我们|本公司|本团队|团队)?\s*(?:正式\s*)?(?:发布|推出|上线)(?:了)?\s*[：:]?\s*([^，。；：\n]{2,80})/gmu,
  /^(.+?)\s+(?:正式\s*)?发布$/gmu,
  /^(?:正式发布|推出|上线)(?:了)?[：:]?\s*([^，。；：\n]{2,80})/gmu,
  /^([A-Z][\p{L}\p{N} ._-]{1,80}?)\s*(?:自[^。\n]{0,40})?正式发布/giu
];

const modelReleaseIntent = /(?:models?|模型).{0,80}(?:latest|current|list|announce|announcement|release|launch|timeline|最新|当前|列表|发布|推出|上线)|(?:latest|current|list|announce|announcement|release|launch|timeline|最新|当前|列表|发布|推出|上线).{0,80}(?:models?|模型)/iu;
const identifierIntent = /\bapi\b|model\s*ids?|identifiers?|标识符|调用标识|接口参数/iu;

export function extractPageEntityEvidence(input: {
  url: string;
  title: string;
  content: string;
  claims: WebClaim[];
  publishedAt?: string;
}): PageEntityEvidence[] {
  const releaseClaims = input.claims.filter(isModelReleaseClaim);
  if (!releaseClaims.length) return [];
  if (!isKnownOfficialUrl(input.url) && !matchesClaimOfficialDomain(input.url, releaseClaims)) return [];

  const title = cleanPageTitle(input.title);
  const candidates = new Map<string, { entity: string; patterns: Set<string>; titleExactMatch: boolean }>();

  for (const pattern of releaseTitlePatterns) {
    const match = title.match(pattern);
    const entity = sanitizeEntity(match?.[1]);
    if (entity) addCandidate(candidates, entity, match?.[0] ?? entity, true);
  }

  const searchableContent = input.content.slice(0, 80_000);
  for (const tableEntity of extractModelTableEntities(searchableContent)) {
    addCandidate(candidates, tableEntity.entity, tableEntity.evidencePattern, false);
  }
  const datedReleaseEntities = extractLatestDatedModelReleases(searchableContent);
  for (const releaseEntity of datedReleaseEntities) {
    addCandidate(candidates, releaseEntity.entity, releaseEntity.evidencePattern, false);
  }
  for (const pattern of releaseLinePatterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(searchableContent)) !== null) {
      const entity = sanitizeEntity(match[1]);
      if (entity && hasModelContext(entity, searchableContent)) {
        const newestDatedFamilyRelease = datedReleaseEntities.find((release) =>
          release.family === modelFamilyKey(entity)
        );
        if (newestDatedFamilyRelease && normalizeEntity(newestDatedFamilyRelease.entity) !== normalizeEntity(entity)) {
          if (match.index === pattern.lastIndex) pattern.lastIndex += 1;
          continue;
        }
        addCandidate(candidates, entity, match[0], false);
      }
      if (match.index === pattern.lastIndex) pattern.lastIndex += 1;
    }
  }

  return [...candidates.values()]
    .filter(({ entity, titleExactMatch }) => titleExactMatch || hasModelContext(entity, searchableContent))
    .map(({ entity, patterns, titleExactMatch }) => {
      const urlEntityMatch = urlContainsEntity(input.url, entity);
      const exactEntityMatch = titleExactMatch && urlEntityMatch;
      return {
        entity,
        aliases: entityAliases(entity),
        claimIds: releaseClaims.map((claim) => claim.id),
        sourceUrls: [input.url],
        evidencePatterns: [...patterns],
        directness: 'direct',
        requiredMention: true,
        ...(input.publishedAt ? { publishedAt: input.publishedAt } : {}),
        exactEntityMatch,
        titleExactMatch,
        urlEntityMatch
      };
    });
}

export function mergeEvidenceEntities(values: EvidenceEntity[]): EvidenceEntity[] {
  const merged = new Map<string, EvidenceEntity>();
  for (const value of values) {
    const key = normalizeEntity(value.entity);
    if (!key) continue;
    const current = merged.get(key);
    if (!current) {
      merged.set(key, {
        ...value,
        aliases: unique([value.entity, ...value.aliases]),
        claimIds: unique(value.claimIds),
        sourceUrls: unique(value.sourceUrls),
        evidencePatterns: unique(value.evidencePatterns)
      });
      continue;
    }
    merged.set(key, {
      ...current,
      aliases: unique([...current.aliases, ...value.aliases]),
      claimIds: unique([...current.claimIds, ...value.claimIds]),
      sourceUrls: unique([...current.sourceUrls, ...value.sourceUrls]),
      evidencePatterns: unique([...current.evidencePatterns, ...value.evidencePatterns]),
      directness: current.directness === 'direct' || value.directness === 'direct' ? 'direct' : 'indirect',
      requiredMention: current.requiredMention || value.requiredMention,
      publishedAt: newestDate(current.publishedAt, value.publishedAt)
    });
  }
  return [...merged.values()];
}

export function isModelReleaseClaim(claim: WebClaim) {
  return modelReleaseIntent.test(`${claim.text} ${claim.searchQueries.join(' ')}`)
    && !identifierIntent.test(claim.text);
}

export function normalizeEntity(value: string) {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function addCandidate(
  candidates: Map<string, { entity: string; patterns: Set<string>; titleExactMatch: boolean }>,
  entity: string,
  evidencePattern: string,
  titleExactMatch: boolean
) {
  const key = normalizeEntity(entity);
  if (!key) return;
  const current = candidates.get(key);
  if (current) {
    current.patterns.add(evidencePattern.trim());
    current.titleExactMatch ||= titleExactMatch;
    return;
  }
  candidates.set(key, {
    entity,
    patterns: new Set([evidencePattern.trim()]),
    titleExactMatch
  });
}

function sanitizeEntity(value: string | undefined) {
  if (!value) return undefined;
  const cleaned = value
    .replace(/^#+\s*/, '')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[.。,:：;；]+$/, '')
    .trim();
  if (cleaned.length < 2 || cleaned.length > 120) return undefined;
  if (/^(?:our|the|a|an)\s+(?:position|approach|statement|report|research)\b/iu.test(cleaned)) return undefined;
  if (/^(?:它|其|该|此|这(?:个|款|一)?|其中|同一天)/u.test(cleaned)) return undefined;
  if (/(?:并非|尚未|未)$/u.test(cleaned)) return undefined;
  if (/\[[^\]]+\]\([^)]+\)/u.test(cleaned) && /(?:客户|可用|提供|访问|批准)/u.test(cleaned)) return undefined;
  if (/(?:提供给|获批准|有限可用|并非正式发布|如需获取)/u.test(cleaned)) return undefined;
  return cleaned;
}

function extractModelTableEntities(content: string) {
  const lines = content.split(/\r?\n/);
  const entities: Array<{ entity: string; evidencePattern: string }> = [];
  for (let index = 0; index < lines.length - 1; index += 1) {
    const header = lines[index]?.trim() ?? '';
    const separator = lines[index + 1]?.trim() ?? '';
    if (!/^\|.*\|$/u.test(header) || !/^\|(?:\s*:?-{3,}:?\s*\|)+$/u.test(separator)) continue;

    const context = lines.slice(Math.max(0, index - 8), index).join('\n');
    if (!/(?:latest|current)\s+models?|model\s+(?:overview|comparison)|最新模型|当前模型|模型对比|模型概述/iu.test(context)) continue;

    const cells = header.split('|').slice(1, -1).map((cell) => sanitizeEntity(cell));
    const candidates = cells.slice(1).filter((cell): cell is string => Boolean(cell));
    if (candidates.length < 2) continue;
    for (const entity of candidates) {
      if (!isLikelyModelName(entity, content)) continue;
      entities.push({ entity, evidencePattern: header });
    }
  }
  return entities;
}

function extractLatestDatedModelReleases(content: string) {
  const lines = content.split(/\r?\n/);
  const releases: Array<{ entity: string; evidencePattern: string; timestamp: number; family: string }> = [];
  let currentDate: { label: string; timestamp: number } | undefined;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const parsedDate = parseReleaseDateHeading(line);
    if (parsedDate) {
      currentDate = parsedDate;
      continue;
    }
    if (!currentDate) continue;

    const heading = line.replace(/^#{1,6}\s*/, '').replace(/^\*\*(.+)\*\*$/u, '$1').trim();
    const match = heading.match(/^(.+?)\s+(?:发布|正式发布|launch|launched|release|released)$/iu);
    const entity = sanitizeEntity(match?.[1]);
    if (!entity || !isLikelyModelName(entity, content)) continue;
    releases.push({
      entity,
      evidencePattern: `${currentDate.label} — ${heading}`,
      timestamp: currentDate.timestamp,
      family: modelFamilyKey(entity)
    });
  }

  const newestByFamily = new Map<string, typeof releases[number]>();
  for (const release of releases) {
    const current = newestByFamily.get(release.family);
    if (!current || release.timestamp > current.timestamp) newestByFamily.set(release.family, release);
  }
  return [...newestByFamily.values()].sort((left, right) => right.timestamp - left.timestamp);
}

function parseReleaseDateHeading(line: string) {
  const normalized = line.replace(/^#{1,6}\s*/, '').replace(/\*+/g, '').trim();
  const chinese = normalized.match(/^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日$/u);
  if (chinese) {
    const timestamp = Date.UTC(Number(chinese[1]), Number(chinese[2]) - 1, Number(chinese[3]));
    return { label: normalized, timestamp };
  }
  const timestamp = Date.parse(normalized);
  if (!Number.isNaN(timestamp) && /\b(?:19|20|21)\d{2}\b/u.test(normalized)) {
    return { label: normalized, timestamp };
  }
  return undefined;
}

function modelFamilyKey(entity: string) {
  return normalizeEntity(entity)
    .split(' ')
    .filter((token) => !/^v?\d+(?:\.\d+)*$/u.test(token))
    .filter((token) => !/^(?:model|模型)$/u.test(token))
    .join(' ');
}

function isLikelyModelName(entity: string, content: string) {
  if (/^(?:feature|features|特性|模型|model|description|描述)$/iu.test(entity)) return false;
  if (/\d/.test(entity)) return true;
  const escaped = escapeRegExp(entity);
  return new RegExp(`${escaped}.{0,120}(?:API\\s*ID|model|模型)`, 'iu').test(content);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cleanPageTitle(value: string) {
  return value
    .replace(/\s+[|\\]\s+[^|\\]{2,80}$/u, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasModelContext(entity: string, content: string) {
  const normalizedContent = content.toLowerCase();
  const position = normalizedContent.indexOf(entity.toLowerCase());
  if (position < 0) return /\d/.test(entity);
  const context = normalizedContent.slice(Math.max(0, position - 180), position + entity.length + 220);
  return /\bmodels?\b|模型|大语言模型|推理模型/iu.test(context) || /\d/.test(entity);
}

function urlContainsEntity(rawUrl: string, entity: string) {
  try {
    const pathname = decodeURIComponent(new URL(rawUrl).pathname);
    const urlTokens = normalizeEntity(pathname).split(' ').filter(Boolean);
    const entityTokens = normalizeEntity(entity).split(' ').filter(Boolean);
    return entityTokens.length > 0 && entityTokens.every((token) => urlTokens.includes(token));
  } catch {
    return false;
  }
}

function matchesClaimOfficialDomain(rawUrl: string, claims: WebClaim[]) {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase().replace(/^www\./u, '');
    return claims.some((claim) => claim.preferredDomains.some((rawDomain) => {
      const domain = rawDomain.toLowerCase().replace(/^https?:\/\//u, '').split('/')[0]!.replace(/^www\./u, '');
      return Boolean(domain) && (hostname === domain || hostname.endsWith(`.${domain}`));
    }));
  } catch {
    return false;
  }
}

function entityAliases(entity: string) {
  const words = entity.split(/\s+/).filter(Boolean);
  const aliases = [entity];
  if (words.length >= 3 && /^[A-Z][\p{L}\p{N}.-]*$/u.test(words[0]!)) {
    aliases.push(words.slice(1).join(' '));
  }
  return unique(aliases);
}

function newestDate(left?: string, right?: string) {
  if (!left) return right;
  if (!right) return left;
  return Date.parse(right) > Date.parse(left) ? right : left;
}

function unique(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
