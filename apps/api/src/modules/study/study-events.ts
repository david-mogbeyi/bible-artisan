/**
 * Event types more than one module writes. A Question node is created by a study edit (BIB-20's
 * new main question) and by the node API (BIB-25), and both write this one event with one shape:
 * `{ questionNodeId, branchId }`, `branchId` being the initial branch this question rooted, or
 * null (see `StudyGraphService.ensureInitialBranch`).
 */
export const QUESTION_CREATED = 'question_created';
