import type { GraphResponse, NodeSummary } from '@bible-artisan/contracts';

/** A conclusion that uses the node about to be deleted as supporting evidence. */
export interface AffectedConclusion {
  node: NodeSummary;
  /** No other live supporting relationship would remain. */
  leftWithoutEvidence: boolean;
  /** It is "Established by me" and would be left without evidence, so it loses the marker. */
  losesEstablished: boolean;
}

export interface DeletionImpact {
  /** Live relationships touching the node: they are removed with it. */
  edgeCount: number;
  affectedConclusions: AffectedConclusion[];
  isMainQuestion: boolean;
  isBranchRoot: boolean;
  /** Live Scripture duplicates naming it: its oldest becomes the original. */
  duplicateCount: number;
}

type Edge = GraphResponse['edges'][number];

/** The conclusion a live edge supports (an incoming `supports`, an outgoing `inference_from`). */
function supportedConclusion(edge: Edge): { conclusionId: string; otherId: string } | null {
  if (edge.type === 'supports')
    return { conclusionId: edge.targetNodeId, otherId: edge.sourceNodeId };
  if (edge.type === 'inference_from') {
    return { conclusionId: edge.sourceNodeId, otherId: edge.targetNodeId };
  }
  return null;
}

/**
 * What deleting `nodeId` would affect (BIB-31), from the cached graph snapshot, before anything is
 * sent. Advice only: the server decides and reports what actually happened. Supporting evidence is
 * BIB-30's definition (an incoming `supports` or an outgoing `inference_from` from a live node).
 */
export function deletionImpact(
  snapshot: Pick<GraphResponse, 'nodes' | 'edges' | 'branches'>,
  nodeId: string,
  mainQuestionNodeId: string | null,
): DeletionImpact {
  const nodesById = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const touching = snapshot.edges.filter(
    (edge) => edge.sourceNodeId === nodeId || edge.targetNodeId === nodeId,
  );
  const affectedIds = new Set<string>();
  for (const edge of touching) {
    const support = supportedConclusion(edge);
    if (support && support.otherId === nodeId && support.conclusionId !== nodeId) {
      affectedIds.add(support.conclusionId);
    }
  }
  const affectedConclusions = [...affectedIds].flatMap((conclusionId) => {
    const node = nodesById.get(conclusionId);
    if (!node || node.type !== 'conclusion') return [];
    const remaining = snapshot.edges.some((edge) => {
      const support = supportedConclusion(edge);
      return (
        support !== null &&
        support.conclusionId === conclusionId &&
        support.otherId !== nodeId &&
        nodesById.has(support.otherId)
      );
    });
    return [
      {
        node,
        leftWithoutEvidence: !remaining,
        losesEstablished: !remaining && node.established,
      },
    ];
  });
  return {
    edgeCount: touching.length,
    affectedConclusions,
    isMainQuestion: mainQuestionNodeId === nodeId,
    isBranchRoot: snapshot.branches.some((branch) => branch.rootNodeId === nodeId),
    duplicateCount: snapshot.nodes.filter((node) => node.canonicalNodeId === nodeId).length,
  };
}
