export type ArtifactSessionToken = Readonly<{
  conversationId?: string;
  epoch: number;
}>;

export function createArtifactSessionToken(conversationId: string | undefined, epoch: number): ArtifactSessionToken {
  return { conversationId, epoch };
}

export function shouldApplyArtifactSessionResponse(
  request: ArtifactSessionToken,
  current: ArtifactSessionToken,
  enabled: boolean
) {
  return enabled
    && request.epoch === current.epoch
    && request.conversationId === current.conversationId;
}
