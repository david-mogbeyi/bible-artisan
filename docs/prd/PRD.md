<!-- Snapshot of the approved PRD taken 2026-09-30 for offline agent/engineer reference.
     Source of truth: https://docs.google.com/document/d/1SRkPCB7mp4kgpaACI5ERztOvZSvTfeOfFgns_Vuce-U/edit
     If the Google Doc changes, re-export and replace this file in its own PR. -->

# **Bible Artisan Product Requirements Document**

Version 1.0 • Proposed implementation baseline • Desktop first responsive web

This document specifies a private Bible study workspace that preserves a user's investigation across Scripture passages, questions, observations, and conclusions. It is the implementation baseline for product design, UX, database and API contracts, and later Linear epic planning. The MVP validates whether people can follow a complex study and reliably resume it without reconstructing their reasoning. Requirements marked MVP are launch requirements; future capabilities are explicitly separated. Product targets below are proposed validation thresholds, not measured results.

# **1. Executive Summary**

Deep Bible study is non-linear. Readers move between passages, questions, word meanings, and interpretations; ordinary reading history preserves destinations but rarely preserves why they went there. The proposed product combines a Bible reader, a visual study graph, a chronological Study Thread, and a living summary to retain both knowledge and the path taken to develop it.

The graph answers “What is connected to what?” The thread answers “How did I get here?” The summary answers “What have I established, and what remains open?” These are separate representations backed by explicit domain data, rather than three renderings of a chat transcript.

The core value proposition is continuity of thought. AI helps track, connect, retrieve, challenge, and synthesize. Users author or explicitly adopt their conclusions. An AI output never silently becomes an accepted interpretation, an established finding, or an answer to a question.

Ship a single-user responsive web MVP with one public-domain English translation, reference and keyword search, six node types, typed edges, automatic event capture, a readable thread, provenance-aware AI summaries, autosave, and study resumption. Use a TypeScript modular monolith and PostgreSQL. Exclude multiplayer, native mobile, semantic retrieval infrastructure, and integrated scholarly corpora until the core model is validated.

# **2. Product Vision**

Enable a reader to build a durable, inspectable record of Bible study without manually documenting every navigation step. A study should remain understandable after weeks away, and a conclusion should retain the evidence and user judgments that produced it.

Longer term, studies contribute to a personal Scripture knowledge graph. A passage becomes an entry point into prior questions, reasoning, and sources. That future view remains a projection of privately owned study records; it must not collapse competing interpretations into a single authoritative answer.

The product succeeds when users can resume an investigation faster, distinguish evidence from interpretation, and explain their own reasoning. Generating more AI text is not a success criterion.

# **3. Problem Statement**

The user loses the original question while following cross-references, forgets why a passage was opened, and mixes tentative ideas with settled conclusions. Notes capture isolated statements; chat transcripts bury structure; manual mind maps interrupt reading. A graph alone also fails because its present edges cannot reconstruct repeated visits or historical changes.

The application must capture low-friction navigation context, support deliberate reasoning records, and expose unanswered branches. It must preserve uncertainty and revision history. It cannot determine a user's theological certainty from activity frequency or model confidence.

The initial validation hypothesis is that an automatically captured thread plus a user-owned graph reduces the effort required to reconstruct a study. Test this through observed resume tasks, not self-reported enthusiasm alone.

# **4. Target Users**

## **Primary personas**

The independent deep-study reader follows 10–30 passages around a question, writes observations, and returns over several days. Their need is a record that preserves the investigation with minimal interruption.

The small-group teacher prepares a discussion by collecting passages and evaluating interpretations. Their need is a traceable outline of evidence, uncertainties, and questions. Teaching outputs are secondary; the MVP remains a private research workspace.

## **Secondary personas**

The theology student needs source attribution and historical reasoning. Manual source records support initial use; advanced language resources and academic integrations are future work.

The reflective mobile reader captures a question or note during reading and later develops it on desktop. Their MVP experience emphasizes reading, capture, and review.

Do not assume a denomination, level of theological education, or acceptance of AI interpretation. The MVP supports English UI and English Bible search; users may enter Unicode notes, including Greek and Hebrew.

# **5. Jobs To Be Done**

  - When a phrase raises a question, create an investigation anchored to the selected text without leaving the reader.
  - When I follow another passage, remember the question and prior location that motivated the visit.
  - When passages suggest a finding, record my interpretation separately from Scripture text and external commentary.
  - When new evidence challenges a conclusion, revise it while preserving the previous statement and its rationale.
  - When I return later, recover the active question, last meaningful location, and unresolved branches.
  - When I ask how I reached a conclusion, inspect the recorded evidence and visits without invented transitions.

# **6. Product Principles**

  - Preserve thought with minimal interruption. Capture navigation automatically; do not automatically interpret its theological meaning.
  - Keep users in control. Acceptance, establishment, revision, and abandonment require an explicit user action.
  - Separate provenance from certainty. Authorship, source, adoption, and epistemic status are independent fields.
  - Make uncertainty visible. AI suggestions and summaries carry labels and evidence links; disputed interpretations remain qualified.
  - Keep the reader usable without AI. Creation, notes, graph operations, search, and resumption work when AI is disabled or unavailable.
  - Prefer reversible actions. Archive and soft delete before permanent removal; undo creates compensating events rather than rewriting history.
  - Build a simple core. Relational nodes and edges, append-oriented events, bounded AI context, and one modular backend.

# **7. Scope**

## **MVP**

Include all sixteen core capabilities requested in the brief: authentication, study creation, reference navigation, keyword search, Scripture nodes, questions, thoughts and observations, conclusions, connections, graph canvas, automatic activity tracking, Study Thread, AI living summary, autosave, resume, and study library. Each is necessary to validate continuity of study.

Additional MVP support includes phrase anchors, highlights, basic rich notes, manual source citations, manual reference-following, question branches, user-marked established findings, conclusion versions, undo for graph mutations, desktop graph/list modes, mobile capture and review, and Markdown plus structured JSON export. Export is included to make the private study portable and reduce data-loss concerns.

Ship one WEB edition initially. Keep translation selection in the reader, even if only one enabled option exists. The architecture supports more; translation comparison is not a launch requirement.

## **Post MVP**

PWA installability and licensed caching, translation comparison, curated cross-reference datasets, semantic search, Greek/Hebrew word-study nodes and morphology, lexicons, Church Fathers, commentary integrations, uploads, PDF/outline/image export, personal cross-study graph, advanced clustering, sharing, collaboration, tablet refinements, and native companion apps.

## **Explicit Non Goals**

No social network, public theological debate, church management, sermon-production suite, full Logos replacement, hundreds of integrations, real-time multiplayer, native apps, sophisticated original-language parser, custom vector database, offline-first synchronization, or automated theological authority. No billing subsystem or subscription tiers in the MVP validation build.

# **8. Core Concepts and Domain Language**

Study: a durable investigation owned by one user, containing title, optional description, starting passage, original and main questions, nodes, edges, notes, event history, summary, tags, and lifecycle metadata. A Study can span days.

Session: one period of activity within a Study. Start on the first meaningful study action; close after 30 minutes without such activity or explicit exit. Navigational restoration alone does not create a session. Concurrent tabs have separate sessions and a shared study revision.

Node: a study-local content object. MVP types are Scripture, Question, Observation, Thought, Conclusion, and Source. Word Study is reserved for a future schema version. Notes attach to nodes or the study; they are not automatically additional graph nodes.

Edge: a user-visible relationship between two nodes in the same Study, with semantic type, provenance, and optional note. Navigation ancestry is stored in events and branch memberships, not inferred from edge semantics.

Thread: the human-readable chronological projection of StudyEvents. It retains repeated visits and the context of each visit.

Observation: a user statement about what they notice, labeled textual observation or interpretation. Neither subtype changes Scripture text.

Conclusion: a versioned user judgment with an epistemic status. “Established” means established by this user within this study, not universal doctrinal truth.

Source: bibliographic metadata and an optional quoted excerpt from external material, clearly labeled as commentary or research.

AI suggestion: a proposed relationship, passage, question, thought, or tension. It exists outside the canonical graph until accepted. Accepted content retains AI origin and user adoption.

Branch: an investigation route rooted in a question or passage. It is a lightweight navigation grouping, not a tree constraint on the knowledge graph. A node can belong to multiple branches.

# **9. Information Architecture**

Global navigation contains New Study, Home, Bible, Studies, Library/Search, and up to five recent studies. “Studies” opens the study library; “Library/Search” searches saved study titles, tags, and user notes, with sources as a later tab. “Bible” supports reading outside a study without producing study events.

Routes: /home; /studies; /studies/new; /studies/:id; /bible; /library; /settings. Workspace selection and pane state use stable query parameters where useful; private note text and search text never appear in public URLs. Sign-in returns to the requested authorized route.

Workspace toolbar contains editable study title, graph/list modes, Search Bible, Add Note, AI Assistant, View Options, and save status. Workspace content has graph/list as the primary center, Study Thread as the lower or adjacent chronological region, and a right inspector with Reader, Summary, and Assistant tabs. This preserves the three conceptual regions without forcing four permanently visible narrow panes. Desktop users can dock the reader beside the graph and collapse the thread or summary independently.

Persist last selected node, active branch, reader passage and translation, viewport, pane widths, and collapsed branches as per-user view state. Persisted content remains independent of the layout library's objects.

# **10. Complete User Experience**

A new user signs in using an email OTP, sees a short introduction to graph/thread/summary, and starts with Romans 9:1. A title is derived deterministically from the starting reference until the user edits it. The main question is optional; adding “What is conscience?” creates a Question node and establishes the initial branch.

Selecting the conscience phrase offers Ask Question, Add Observation, Add Note, and Highlight. The user opens Romans 2:15 from search while the question branch is active. The graph receives one Scripture node and a neutral references edge to the origin when the user explicitly follows into the study. The thread records the origin, query context, branch, and new visit. AI may suggest a more specific semantic edge; no suggestion silently replaces the neutral relationship.

The user adds 1 Timothy 1:5, 1 Timothy 1:19, and Hebrews 9:14, then writes the tentative conclusion that conscience functions as an internal moral witness. Supporting edges are user-created or explicitly accepted. “Can conscience be wrong?” starts a second branch and leads to 1 Corinthians 8:7, Titus 1:15, and 1 Timothy 4:2. The AI may flag tension with an earlier reliability claim; the user decides whether to mark it challenged or revise it.

Returning to Romans 9:1 focuses its existing node and adds another visit event. The user selects “in the Holy Spirit,” opens Romans 8:16 and Acts 24:16, and considers the relationship between conscience and spiritual witness. The living summary distinguishes textual observations from tentative interpretations. Greek συνείδησις can be entered as a question or manual source note in MVP; native word-study tools follow later.

The user closes the browser after save acknowledgment. On return, the resume card presents the saved current question, last passage, last user conclusion, and open questions. Resume from Last Point restores the saved context. The user can review the graph, summary, or event path without re-reading all twenty passages.

# **11. Screen-by-Screen UX Specification**

Shared behavior: loading never blanks previously saved content; empty states offer the next useful action; errors are scoped to the failed component; offline status is persistent and distinguishes locally queued content from server-saved content. Focus moves to an error summary or opened panel appropriately and returns to the invoking control on close. Screen-level acceptance is specified below and formalized in section 21.

## **Home**

Purpose and layout: provide one clear continuation route, with Continue Studying first, three recent studies, up to five open questions, and New Study plus Bible Search. Recently viewed passages appear below; frequently explored topics are deferred to avoid a dashboard-heavy launch.

Primary action: resume the most recently active study. Secondary actions: create, browse library, open a question. Default shows saved cards; loading shows card skeletons; empty offers Start with a Passage or Start with a Question; error preserves available cards and offers Retry; offline allows cached review and routes to previously loaded study content. Clicking a question opens its parent study and selects that node.

## **Study Library**

Purpose and layout: searchable study list with title, starting passage, last activity, tag chips, pin and archive state. Controls include title/tag search, recent/title/created sorting, and Archived filter. Pinned studies form a separate group, using the same sort within that group.

Primary action: open a study. Secondary actions: rename, pin, tag, archive, export, delete to trash. Default lists the latest 50 with cursor pagination; loading preserves current results; empty distinguishes no studies from no filter matches; error offers Retry; offline shows cached results with freshness label. Archive removes a study from active results but remains searchable in Archived. Empty search resets filters. No list action generates study reasoning events except lifecycle changes.

## **New Study**

Purpose and layout: compact form with optional title, optional question, optional starting passage, and default translation. Reference validation is inline. At least a question or a passage is required; an explicit Blank Study option creates an untitled empty workspace.

Primary action: Create Study. Secondary: cancel, open Bible first. Default enables creation when valid; loading disables repeated submit; empty shows examples; error retains all inputs; offline retains the draft locally and blocks server creation. Creation atomically makes the study, optional root nodes, initial branch, and study\_created event. Repeated submit with the same mutation key returns the original study.

## **Study Workspace**

Purpose and layout: left global navigation, top toolbar, graph/list center, thread region, reader/summary inspector. At widths ≥1280px support simultaneous graph, reader, thread, and summary through docking; at 900–1279px allow one inspector tab and collapsible thread. Below 900px show Reader, Notes, Thread, Summary, and Graph Preview tabs; full drag-based graph editing is unavailable on phones.

Primary actions: read, capture a question or observation, connect evidence, inspect summary. Secondary: view options, export, archive, undo/redo. Default restores view state; loading renders the shell then graph/reader independently; empty graph offers Add Passage or Question; partial errors do not disable notes; offline shows cached study and a bounded local queue. A missing or unauthorized study shows a neutral unavailable page. Archive makes the workspace read-only until unarchived.

## **Graph Canvas**

Purpose and layout: node canvas with zoom/pan controls, fit button, minimap, filter button, and selection inspector. Nodes show type icon, title, origin label, and status; previews show at most 160 characters. Text and icons supplement color.

Primary actions: select/open, move, connect, create. Secondary: focus branch, collapse branch, multi-select, layout selection, duplicate, hide sources, delete. Default restores positions; loading shows canvas skeleton; empty offers first node; error offers List View; offline allows cached movement and queued edits subject to queue limits. Enter opens a selected node; Escape clears selection; text editors suppress canvas shortcuts. Zoom and pan do not change content revision or thread.

## **Bible Reader**

Purpose and layout: reference input, translation selector, chapter navigation, passage text, selection action menu, and linked notes. A chapter is the reading context; the exact selected verse range is the graph target. Show translation/edition attribution adjacent to text.

Primary actions: navigate and select text. Secondary: add to study, ask question, create note/observation, highlight, follow a recognized reference. Default opens saved passage; loading retains prior text with an overlay; empty asks for a reference; error shows Retry and preserves existing notes; offline opens cached chapters only. Selection never rewrites text. A selection across verses records per-verse anchors. Translation changes replace reader text, retain the existing node, and never remap highlights by guessed offsets.

## **Study Thread**

Purpose and layout: reverse-chronological session groups with readable cards and linked entities; a chronological toggle is available. Primary action: open an event's node/context. Secondary: filter by question/conclusions/navigation and expand internal details. Default shows 50 visible events; loading adds skeletons after existing cards; empty explains automatic capture; error offers Retry; offline reads cached events and labels queued items. Three visits to Romans 8:16 remain three cards. Clicking an old event creates a new visit, rather than moving the historical event.

## **AI Summary**

Purpose and layout: focus/current question, textual observations, user-established findings, tentative findings, tensions, open questions, conclusions, abandoned hypotheses, and next directions. Each generated statement has citations and an AI label.

Primary actions: inspect evidence and regenerate. Secondary: edit the main question through normal study controls, dismiss/report an item, and turn a suggestion into a user-adopted node. Default shows latest valid summary with revision/freshness; loading retains it; empty offers Generate Summary; error retains the last valid artifact and shows retry; offline displays cached summary marked unable to refresh. AI-disabled state explains how to enable consent. No “accept all as conclusions” action exists.

## **Search**

Purpose and layout: Bible tab with reference/keyword input, translation and optional book filter; saved-content tab for title/tag/note lookup. Primary action: open a result; secondary: add to active study, refine filters. Default shows recent local Bible searches; loading occurs after 300ms debounce or submit; empty distinguishes no results from empty query; error retains query/results; offline offers cached reference lookup and disables uncached keyword search. Search previews do not add graph nodes or visit events until opened.

## **Study Resume Experience**

Purpose and layout: entry card or overlay with last meaningful passage/question, latest saved user conclusion, open questions, last activity, and summary freshness. Primary action: Resume from Last Point. Secondary: Open Graph, Review Summary, Explore Open Questions. Default uses saved deterministic state immediately; loading affects only optional AI continuation text; empty study offers Add Passage; error falls back to saved graph/thread; offline restores cached state. Dismissal opens the workspace without changing the original question.

# **12. Graph System**

## **Typed nodes and identity**

Use a StudyNode base entity with typed payload validation and common title, body, origin, created/updated metadata, revision, and soft-deletion timestamp. Scripture has immutable reference, translation, and edition identity; Question has status; Observation has observationKind and establishment marker; Conclusion has its current version; Source points to bibliographic metadata. Changing a type after creation is disallowed; conversion creates a new node with a derived-from link.

Question statuses: open, partially\_answered, answered, deferred. Every transition requires the user; an answered question may reopen. Answer links do not automatically change status.

Conclusion statuses: tentative, supported, challenged, revised, abandoned. “Supported” requires at least one live incoming supports edge or outgoing inference-from edge. “Established by me” is an independent user marker permitted only on a supported conclusion. Challenging or revising clears that marker until reaffirmed. Revision creates a new immutable version and sets status revised; reaffirmation sets supported again. Abandonment retains all versions and evidence.

Each active Scripture node has a canonical identity of study + normalized reference range + translation + edition. Enforce one canonical node for this key. A deliberate duplicate creates a noncanonical instance linked to the canonical node and labeled Duplicate. Revisits target the canonical node by default. Overlapping ranges remain separate nodes; an exact range match deduplicates. Selected phrases are anchors on the node, not different identities.

## **Relationship semantics**

Directed relationships read source → target: supports provides evidence for target; contradicts asserts conflict with target; qualifies limits target; explains offers explanation of target; references links to cited target; answers answers target Question; raises-question prompts target Question; historical-background supplies historical context for target; linguistic-background supplies language context for target; fulfillment identifies source as proposed fulfillment of target; quotation identifies source as quoting target; inference-from says source claim is inferred from target; derived-from says source content originated from target content/version.

Parallels and related-to are symmetric and stored once with canonical ordered endpoint IDs. The latter has no claim of evidential support. All listed types are available in MVP; the default picker shows references, related-to, supports, qualifies, parallels, and answers, with More Relationships for the rest. Fulfillment/quotation are interpretive relationship labels, never automatic textual proof.

Disallow self-edges and cross-study endpoints. Permit distinct semantic types between the same nodes. For directed edges deduplicate by study/source/target/type; for symmetric edges deduplicate by ordered pair/type. Cycles are valid. Edge notes support plain text up to 2,000 characters, source anchors, and provenance. Deleting an edge does not delete a node.

## **Creation and correction**

Explicit Add to Graph creates a node without an edge when no origin is selected. Follow into Study creates or focuses the target and creates a references edge from the origin Scripture, or related-to from a non-Scripture origin. The event preserves the actual visit origin even if the edge already exists. Merely browsing a chapter does not inflate the graph.

AI proposals appear as dashed previews with “AI suggested,” explanation, and evidence links. Accept inserts a canonical edge retaining AI origin/adopter. Reject suppresses the same proposal signature until relevant content changes or the user requests suggestions again. Editing an accepted edge creates an event and preserves the original proposal reference. Relationship editing always presents the direction in words.

## **Layout and interactions**

Place new nodes near the active branch root with collision avoidance, preserving existing coordinates. Save positions on drag end, not every frame. Manual positioning is primary; provide explicit arrange-selection/arrange-branch using a deterministic layered layout with cycle handling. Preview the arrangement and allow cancel/undo; do not reflow the whole graph after each insertion.

MVP includes drag, keyboard move, pan, zoom 25–200%, minimap, fit all/selection, previews, selection, Shift multi-selection, edge creation through handles or an accessible Connect dialog, edge editing/removal, deliberate duplication, node-type filters, source toggle, branch collapse, two-hop focus mode, local back/forward selection history, and undo/redo. Duplicating a non-Scripture node copies current content but no edges; duplicating a conclusion starts tentative without an establishment marker.

Branch collapse hides members exclusive to that branch and shows counts; shared nodes stay visible. Focus mode shows the selected node and two-hop neighbors, with a hidden-neighbor count and Expand action. Below 50% zoom, use title/icon/status only. Filters and collapse affect presentation, never export or AI evidence scope. At 500 nodes default to the saved focused branch or List View, rather than displaying every edge. Advanced automatic topic clustering and separately saved subgraphs follow MVP.

Undo retains the last 50 acknowledged graph/content commands per tab; a command whose entity revision changed externally requires resolution rather than overwriting. Conclusion revision remains in history after undo. Navigation back/forward is separate from content undo.

# **13. Study Thread System**

A domain mutation and its event commit in one database transaction. Read/navigation events commit through an idempotent activity endpoint. Events have server-assigned study sequence, client occurrence timestamp, server recorded timestamp, session, actor, origin, target, branch, parentVisitEventId, content/version references, correlation ID, and schema version. Ordering uses server sequence; offline-delayed events show their original occurrence time and a delayed-sync label.

Visible event families: study\_created; study\_renamed; study\_archived/unarchived; scripture\_opened; scripture\_added\_to\_graph; question\_created/status\_changed; thought\_created; observation\_created/updated/established; conclusion\_created/updated/challenged/established/abandoned; node\_connected; edge\_updated/removed; node\_deleted/restored; cross\_reference\_followed; source\_opened; note\_created; AI\_suggestion\_accepted/rejected; summary\_generated. Future word\_study\_opened remains reserved.

Internal-only families: phrase\_selected, search\_performed, note\_autosaved, node\_position\_saved, view\_state\_saved, summary\_queued/failed, session\_started/ended, and validation failures. Phrase selection is captured only when committed to an action or stable selection for at least two seconds; cap retained passive selection events at 100 per session. Search stores scoped query only in the private study event, never analytics. Pan/zoom, pointer motion, keystrokes, and transient selections are not retained as events.

A reader open is recorded after visible text loads successfully. Re-rendering and reload restoration do not create visits. Re-opening the same passage via a deliberate user navigation does. Rapid search input does not create visits. A combined follow action may create several atomic events sharing a correlation ID; the thread renders one human-readable card while the raw events remain available.

Example card: “From Romans 9:1, followed Romans 8:16 while investigating Conscience and the Holy Spirit.” If no question was selected, say “Opened Romans 8:16 from search”; do not invent motive. Return to an earlier question records the change of branch. Event details distinguish user-authored rationale from AI suggested explanation.

Events are append-oriented, not full event sourcing. Current node data is the operational state; events support chronology, attribution, and traceability. Deleted targets render a tombstone label and historical permitted excerpt, with Restore when eligible. Edits have version references where exact historical text matters. Cosmetic edits can group visually within two minutes while preserving raw event rows.

# **14. Bible Reader & Search**

Support single verses, chapter-bounded ranges, whole chapters, and cross-chapter ranges within one book up to 200 verses. Longer requests open a reading chapter rather than create a huge graph node. Book-only requests open chapter one. Multi-book/discontiguous input requires separate selections. Validate chapter and verse boundaries against the chosen edition's versification.

Reference resolution accepts case-insensitive standard English names and aliases, including Romans 9:1 and Rom 9:1, numeric book forms such as 1 Timothy/1 Tim, spaces, and range separators. Ambiguous abbreviations return candidates; invalid input never fabricates a verse. Normalize to a stable book code and ordered start/end verse IDs. A chapter reference expands deterministically using stored boundaries.

Keyword search defaults to all entered terms, case-insensitive, using the selected translation. Quoted text uses contiguous phrase search, so “bearing witness” is different from bearing witness. Normalize punctuation/Unicode for search while displaying original text. Use PostgreSQL full-text indexes, verify literal phrase adjacency for phrase results, and return highlights plus reference. Sort by text relevance with canonical Bible order as tie-breaker. Default 25 results, maximum 100, cursor pagination. No semantic matching or inferred synonym expansion in MVP. The PostgreSQL documentation recommends GIN indexes for text search; this is a storage choice, not a promise of measured latency. [PostgreSQL text search indexes](https://www.postgresql.org/docs/current/textsearch-indexes.html)

Reference lookup takes precedence only when the parser recognizes a complete reference shape. Otherwise treat input as keywords; a malformed reference shows a correction rather than a misleading keyword result. Study search covers title, tags, and owned note text, with separate result labels.

Verse selection uses verse labels/checkbox affordances; phrase selection uses native text selection and a keyboard-accessible menu. Store selected quote and per-verse start/end offsets in Unicode code points, plus edition ID and verse checksum. Do not use DOM offsets as durable anchors. On import/update mismatch, mark anchor unresolved and ask the user to reselect.

MVP cross-reference following works from Bible references typed in notes, source excerpts, or AI citations. Automatically supplied curated cross-reference lists require a rights-cleared dataset and are post-MVP. Translation comparison and prior-study verse discovery are future UI features. Translation switching clears active selection; a previously selected graph node retains its original translation. Adding the same range in another enabled translation creates its own canonical node; AI comparisons may cite both without merging them.

# **15. Notes and Annotation System**

Provide study-wide notes and notes attached to a node, Scripture verse range, or phrase anchor. MVP editor supports paragraphs, headings, bold/italic, bullet/numbered lists, quotes, links, undo/redo, and Markdown-like input shortcuts. Store a sanitized, versioned Tiptap JSON document plus derived plain text for search/export. Arbitrary HTML, embedded scripts, images, attachments, and collaborative editing are excluded.

Typing a Bible reference offers a resolve action and, after validation, an internal reference link. Typing a node mention selects from nodes in the current study and stores the node ID. A pasted external URL becomes a safe link; it does not automatically fetch a webpage. A general study note remains outside the graph until the user converts a selected excerpt into an Observation or Thought, retaining derived-from provenance.

Highlights support four named colors plus an optional label; text contrast remains readable. A highlight is bound to edition and phrase/verse anchors. Notes are limited to 50,000 characters of derived text; node bodies to 10,000; question/conclusion statements to 4,000; title to 200. Show limits before rejection and preserve the local draft. Note revisions are saved at explicit checkpoints or 30-second intervals while editing, capped at 100 versions per note; conclusion versions have no per-study cap within overall account storage limits.

On deleted targets, retain note content in orphaned-note review with its historical anchor; restoration relinks it. Deleting a note is reversible from trash. AI reads notes only when enabled and relevant to the active request; it never rewrites the note body.

# **16. AI Product Specification**

All capabilities share an authenticated, user-consented, quota-checked request; a bounded context manifest; validated structured output; retained model/prompt/schema versions; evidence references; and explicit user controls. Provider failures leave deterministic study state untouched. AI is supplementary and can be disabled account-wide or per study.

## **Study synthesis**

Trigger: meaningful persisted content changes, manual Regenerate, or stale summary on return. Inputs/context: objective, current question, relevant graph, conclusion versions, open questions, notes, and recent events. Output: the schema in section 17. Persist a new immutable StudySummary revision. Controls: regenerate, inspect citations, report mismatch, disable AI. Failure: retain the last valid summary and mark its freshness; no partial response is published.

## **Relationship detection**

Trigger: explicit Suggest Relationship for two selected nodes, or a user-followed Scripture transition with consent. Inputs/context: both texts, selected phrases, branch question, adjacent accepted edges. Output: zero to three proposed edges with semantics, direction, rationale, and evidence. Persist AISuggestions only. Controls: accept, edit before accepting, reject. Failure: show unavailable or no clear relationship, and preserve the recorded visit. “Romans 8:16 may provide a conceptual parallel around witness language” is appropriate; “proves” requires quoted user attribution.

## **Reasoning reconstruction**

Trigger: How Did I Arrive at This on a conclusion. Inputs/context: requested version, linked evidence, earlier versions, branch events, relevant notes. Output: ordered evidence/event path and gaps, distinguishing recorded steps from interpretation. Persist a request-linked AIResult; deterministic path retrieval is available without AI. Controls: open an event/version and inspect citation. Failure: show the recorded links/timeline and explicitly say the path is incomplete. Never infer missing historical actions as facts.

## **Tension detection**

Trigger: new evidence or conclusion revision plus manual Check for Tensions. Inputs/context: supported and tentative conclusions plus potentially relevant passages and observations. Output: proposed tension items identifying both claim IDs, explanatory text, and an interpretive caveat. Persist suggestions, not conclusion status changes. Controls: dismiss, connect a qualifying/contradicting edge, mark challenged, revise. Failure: no automatic status change; last prior tensions remain marked stale when applicable.

## **Scripture suggestions**

Trigger: user asks What Could I Investigate Next or opens Assistant suggestions. Inputs/context: active question, passages already visited, branch and open questions. Retrieval searches the local allowed Bible corpus first; model-suggested references must resolve server-side before display. Output: at most five valid passages, translation/edition, and qualified relevance reason. Persist suggestions. Controls: preview, open into study, accept as node, dismiss. Failure: omit invalid candidates and show no verified result if none remain. Suggested previews are dashed/labeled and excluded from established summary evidence until accepted or opened as actual evidence.

## **Open question detection**

Trigger: summary generation or explicit Find Unanswered Questions. Inputs/context: user notes, existing question statuses, branches. Output: existing unanswered question IDs plus proposed new questions. Persist proposals separately. Controls: accept a proposed Question node or dismiss. Failure: show existing open questions deterministically. Never mark answered from a model inference.

## **Study continuation and branch summary**

Trigger: resume after at least 24 hours, or Summarize Branch. Inputs/context: latest valid summary, deterministic last context, selected branch memberships, recent meaningful events. Output: concise recap, unresolved question IDs, and optional next steps. Persist AIResult with basis revision. Controls: follow links, regenerate, dismiss. Failure: use deterministic resume card. Stale generations remain historical artifacts and are not presented as current.

## **Trust and theological agency**

Source badges are Scripture Text, You, AI Suggested, AI Summary of Your Study, and External Source. User-adopted AI text retains an AI-origin badge. “Established by me” is separate from these origin labels. Quotations cite the exact source and location; summaries of sources are labeled paraphrases.

The AI must distinguish explicit textual claims from interpretation, acknowledge multiple plausible readings when relevant, and avoid treating a denomination as the default authority. No automatic doctrinal scoring or numerical theological certainty. The example “conscience is not necessarily infallible” is a user's possible conclusion supported within the scenario, not an app-wide finding. The app must not prepopulate it as established.

# **17. Living Study Summary**

Contract version 1 contains studyId, basisContentRevision, generatedAt, promptVersion, modelId, focus, originalQuestionId, currentQuestionId, keyPassages, textualObservations, establishedFindings, tentativeFindings, tensions, openQuestions, conclusions, abandonedHypotheses, nextDirections, coverageWarnings, and contextManifestId.

Every generated item contains id, text, attribution (user\_statement, ai\_synthesis, or source\_interpretation), evidenceRefs, and supportingNodeVersionIds. evidenceRefs are typed node\_version, event, scripture, or source citations. A Scripture citation includes translation/edition and normalized range; a user quote cites a content version. Existing open questions refer to node IDs and statuses; proposed questions/directions remain suggestions. EstablishedFindings can include only user-marked live observations or supported user-established conclusions. The server rejects a model item placed there without an eligible underlying record.

Example outline: focus “Conscience and the Holy Spirit”; original question “What is conscience?”; current question about Romans 9:1 and Romans 8:16; textual observation citing Romans 2:15 witness language; tentative finding about the relationship with spiritual witness; tensions citing a reliability claim and 1 Timothy 4:2; open question about what “in the Holy Spirit” modifies. Include Greek and historical-source questions as unresolved, not as completed analyses.

Significant triggers are node text/status changes, semantic edge changes, note checkpoints, source edits, deletion/restoration, and main/current question changes. Mark the summary stale immediately on these committed changes. Debounce generation for 30 seconds after the last significant commit, with a maximum wait of two minutes during sustained editing. Passive visits, search, selection, position, pane, and highlight-color changes do not trigger synthesis. Opening a new passage may trigger a relationship proposal, independently.

Only one automatic summary job runs per study; changes during generation set a dirty marker and schedule one follow-up. Results with a noncurrent basis revision are stored as historical and never replace the current summary. Manual regenerate is allowed once per ten seconds and is quota checked. Show “Based on an earlier version of this study” until a valid current artifact exists. User notes and conclusions always remain usable during regeneration.

# **18. Study Resumption**

Persist the last meaningful context on server acknowledgment: active question, branch, passage/node, last visit event, viewport, pane preferences, and last user conclusion ID. A view-only pane change may update view state without changing lastActivityAt. Update lastActivityAt for acknowledged visits and content actions, not background polling.

Resume card shows elapsed time in the user's timezone, deterministic active question, up to three open questions with a View All action, recent conclusion with status, and summary freshness. Resume from Last Point restores live entities; if deleted, fall back to the nearest surviving branch root, then starting passage, then list. Open Graph preserves saved coordinates. Review Summary never changes question status. Explore Open Questions selects the oldest open question in the active branch unless the user selects another.

Acceptance scenario: after returning four days later, the reader reaches the saved Romans 8:16 investigation in one action, sees that συνείδησις and grammatical attachment remain unresolved, and can open the prior conclusion's path. This behavior must work without an AI continuation request succeeding.

# **19. Personal Bible Knowledge Graph**

Post-MVP, create an owner-scoped projection across studies keyed by canonical Scripture coordinates and edition-aware mappings. Do not use study-local node IDs as global verse identity. Retain a many-to-many StudyScriptureUsage projection or equivalent indexed query derived from active Scripture nodes, including explicit duplicates without double-counting studies.

Opening Romans 9:1 can show four studies, prior questions/concepts, and recurring user-accepted connections. Compute “strong connection” from an explained rule, such as acceptance in multiple studies, never model authority. Preserve each study's source, conclusion status, and interpretive differences. Cross-study AI retrieval is opt-in and owner-only. Deletion/archiving updates visibility according to library filters; deleting a study removes its projection, and cross-study citations become unavailable rather than leaking cached text.

Initial schema includes owner IDs, canonical Scripture references, typed provenance, and version references to support this later without a graph database. Automatic concept extraction and cross-study merging are future migrations, not hidden MVP requirements.

# **20. Bible Content and Licensing Strategy**

Recommend the World English Bible Protestant edition as the MVP English corpus, sourced from the publisher and imported as an immutable, checksummed release. The publisher states that its text is public domain and identifies the World English Bible name as a trademark; modified text must not be presented under that name. Preserve Scripture verbatim and display translation/edition attribution. [World English Bible publisher notice](https://ebible.org/study/content/texts/engwebp/about.html)

The initial canon is this edition's 66-book corpus. Model book identities and versification explicitly so additional canons and editions can be added later. Choosing this starting corpus is a scope decision, not a theological ranking. Never silently remap deuterocanonical references or verse numbering.

Store the permitted corpus locally in PostgreSQL for deterministic reading, lookup, search, and AI citation validation. This avoids a runtime Bible API dependency. Content import checks verse counts, reference boundaries, Unicode, checksums, and sample passages; a bad import never replaces the active release.

For every later translation, the release checklist must record the licensor, territories, permitted storage/caching/search/quotation/AI-processing/export uses, attribution, expiration, and edition. A Bible API contract does not automatically grant full-text storage or AI use. Providers are accessed through an adapter with explicit caching permissions, retries, and availability handling. A disabled license blocks new retrieval; existing notes survive with translation identifiers and permitted historical anchors. Do not bundle ESV, NIV, or other proprietary text without rights. Review deployment territories and rights records before enabling any additional translation.

# **21. Functional Requirements**

The requirements below are atomic release checks. Their interaction, persistence, API, and failure contracts are specified in sections 11–18 and 23–29. “Saved” always means server acknowledged. A pending optimistic operation is never represented as saved.

## **Identity and study lifecycle**

**FR-AUTH-001 —** Given an unauthenticated visitor, when they verify a valid email OTP, then the server creates or resumes their account and redirects to the authorized requested screen.

**FR-AUTH-002 —** Given an expired or reused OTP, when verification is attempted, then access is refused and the user can request another code without losing form input.

**FR-STUDY-001 —** Given valid initial inputs, when Create Study succeeds, then the study, initial nodes, branch, and creation event exist atomically.

**FR-STUDY-002 —** Given a repeated create request with the same idempotency key, when it reaches the server, then it returns the original result without another study.

**FR-STUDY-003 —** Given an active study, when the owner edits its title, description, main question, pin, or tags, then validated changes persist and appear after reload.

**FR-STUDY-004 —** Given the study library, when the owner selects sort/filter/search, then only owned matching studies appear with stable cursor pagination.

**FR-STUDY-005 —** Given an archived study, when opened, then content is reviewable but mutations return STUDY\_ARCHIVED until the user unarchives it.

**FR-STUDY-006 —** Given a study moved to trash, when opened during the recovery window, then the owner may restore it with its graph, thread, and versions intact.

**FR-STUDY-007 —** Given a study with a missing last-selected node, when Resume is invoked, then the documented surviving-context fallback is applied.

**FR-STUDY-008 —** Given a resumed study, when AI is disabled or fails, then the saved deterministic resume card and workspace still work.

## **Bible and search**

**FR-BIBLE-001 —** Given Romans 9:1 or Rom 9:1, when resolved in the MVP edition, then the same canonical range is returned.

**FR-BIBLE-002 —** Given an invalid verse boundary, when lookup occurs, then no passage is fabricated and a reference-specific validation message appears.

**FR-BIBLE-003 —** Given an ambiguous book alias, when submitted, then selectable candidates appear before passage retrieval.

**FR-BIBLE-004 —** Given a keyword query and translation, when submitted, then all-term results include verified references and highlighted original text.

**FR-BIBLE-005 —** Given a quoted phrase, when searched, then every returned result contains the normalized contiguous phrase.

**FR-BIBLE-006 —** Given a loaded passage, when a phrase action is committed, then edition-specific verse offsets, quote, and checksums are stored.

**FR-BIBLE-007 —** Given a translation change, when new text loads, then existing graph-node identity and highlight anchors remain on their original edition.

**FR-BIBLE-008 —** Given a Bible-reference link, when followed into a study, then a verified passage visit and its originating context are recorded.

**FR-BIBLE-009 —** Given an unavailable chapter, when reading fails, then prior content and notes remain visible with Retry.

## **Graph and reasoning**

**FR-GRAPH-001 —** Given an empty graph, when a valid node is created, then it appears near the active context and survives reload.

**FR-GRAPH-002 —** Given an existing canonical Romans 8:16 node with matching range, translation, and edition, when added again, then the existing node is focused and the intentional visit is retained without a duplicate node.

**FR-GRAPH-003 —** Given a matching canonical node, when Explicit Duplicate is selected, then a labeled noncanonical instance is created without bypassing canonical uniqueness.

**FR-GRAPH-004 —** Given two live nodes in one study, when connected, then the selected edge semantics, direction, provenance, and optional note persist.

**FR-GRAPH-005 —** Given a self-edge or cross-study endpoint, when connected, then the server rejects the relationship with no event or partial write.

**FR-GRAPH-006 —** Given an existing symmetric pair/type, when connected in reverse order, then the existing edge is returned.

**FR-GRAPH-007 —** Given a dragged or keyboard-moved node, when the movement completes, then the position persists without a semantic summary trigger.

**FR-GRAPH-008 —** Given collapsed or filtered nodes, when view options change, then persisted nodes and edges remain unchanged.

**FR-GRAPH-009 —** Given a selected branch, when automatic arrangement is accepted, then only the selected branch positions change and the operation is undoable.

**FR-GRAPH-010 —** Given a deleted evidence node, when a conclusion is inspected, then the unavailable evidence is identified and its reasoning history remains traceable.

**FR-GRAPH-011 —** Given an accepted AI edge, when the user edits its type, then the new relation is shown while AI origin and acceptance history remain retained.

**FR-GRAPH-012 —** Given a command whose revision is current, when Undo occurs, then a compensating mutation restores prior state and creates a new event.

**FR-GRAPH-013 —** Given a keyboard-only user, when Connect is invoked, then endpoints and semantics can be selected without dragging.

**FR-QUESTION-001 —** Given an open question, when the user marks it answered, then its status changes and a question\_status\_changed event is stored.

**FR-QUESTION-002 —** Given an AI proposed answer, when generated, then the existing question status remains unchanged until user action.

**FR-CONCLUSION-001 —** Given a conclusion edit, when saved, then a new immutable version is created with prior version, change rationale, and linked evidence IDs.

**FR-CONCLUSION-002 —** Given a tentative conclusion without live supporting evidence, when marked supported, then the server requests evidence rather than accepting the status.

**FR-CONCLUSION-003 —** Given a supported conclusion, when the user establishes it, then the explicit user marker and event are stored.

**FR-CONCLUSION-004 —** Given an established conclusion, when revised or challenged, then establishment is cleared until explicitly reaffirmed.

**FR-CONCLUSION-005 —** Given an abandoned conclusion, when reviewed, then its earlier versions and evidence remain accessible with abandoned status.

## **Thread and notes**

**FR-THREAD-001 —** Given a successful domain mutation, when its transaction commits, then its matching event is committed atomically.

**FR-THREAD-002 —** Given three deliberate visits to the same verse, when the thread is displayed, then all three visits retain their original contexts.

**FR-THREAD-003 —** Given navigation from an old event, when completed, then the old event is unchanged and a new visit is created.

**FR-THREAD-004 —** Given a retry of the same activity mutation, when accepted, then only one event exists for that mutation ID.

**FR-THREAD-005 —** Given internal-only UI events, when the default thread is displayed, then they are excluded from visible cards.

**FR-THREAD-006 —** Given a multi-event follow action, when rendered, then its correlated records appear as one readable action with expandable details.

**FR-NOTE-001 —** Given a node or study note, when supported rich-text content is saved, then sanitized structured text and searchable plain text persist.

**FR-NOTE-002 —** Given a note target that is deleted, when the study reloads, then the note is retained in orphaned-note review.

**FR-NOTE-003 —** Given a recognized reference in a note, when resolved, then it becomes an internal verified link with no unsolicited graph insertion.

**FR-NOTE-004 —** Given text exceeding the documented limit, when saving is attempted, then the user sees the limit and the local draft is preserved.

## **AI and summary**

**FR-AI-001 —** Given AI is disabled, when a background trigger occurs, then no private study content is sent to an AI provider.

**FR-AI-002 —** Given a relationship proposal, when displayed, then it carries an AI label, rationale, evidence, and Accept/Edit/Reject controls.

**FR-AI-003 —** Given a proposal accepted twice through retries, when persisted, then exactly one canonical artifact and acceptance event are created.

**FR-AI-004 —** Given a rejected proposal signature, when the same unchanged context recurs, then it is suppressed until explicit regeneration or relevant revision.

**FR-AI-005 —** Given a model-generated reference absent from the allowed corpus, when validated, then it is excluded from user-visible citations and suggestions.

**FR-AI-006 —** Given structured output with an invented node or event ID, when validated, then it is rejected and the prior valid artifact remains current.

**FR-AI-007 —** Given a new passage that conflicts with a user claim, when AI detects a tension, then it proposes a review without changing conclusion status.

**FR-AI-008 —** Given a reasoning explanation with no recorded link for a step, when rendered, then the gap is stated rather than described as a historical action.

**FR-AI-009 —** Given a generated summary, when it lists established findings, then each item cites a live eligible user-established record.

**FR-AI-010 —** Given significant content changes, when acknowledged, then the summary is marked stale and generation follows the specified debounce schedule.

**FR-AI-011 —** Given a generation completes against an old basis revision, when persisted, then it is historical and does not replace the current artifact.

**FR-AI-012 —** Given a timeout, quota, or validation failure, when the request ends, then deterministic editing remains available and Retry/status is explicit.

**FR-AI-013 —** Given accepted AI text, when displayed or exported, then AI origin and user adoption remain distinct.

## **Persistence and portability**

**FR-SAVE-001 —** Given an acknowledged edit, when the page reloads, then the server's committed value is restored.

**FR-SAVE-002 —** Given an offline edit, when queued locally, then the UI says Waiting to Sync and does not say Saved.

**FR-SAVE-003 —** Given a revision conflict, when saving, then server and local versions are presented and no silent overwrite occurs.

**FR-SAVE-004 —** Given a full local queue, when another mutation is attempted, then editing is blocked with a draft-preservation/export option.

**FR-EXPORT-001 —** Given an owned study, when JSON export completes, then it includes nodes, edges, events, note revisions, conclusion versions, provenance, and summary basis metadata under a versioned schema.

**FR-EXPORT-002 —** Given Markdown export, when generated, then Scripture/source attribution, status, links, and unavailable-evidence labels are retained.

**FR-PRIVACY-001 —** Given an authenticated owner, when account deletion is confirmed, then sign-in is disabled immediately and the documented purge workflow starts.

# **22. Non-Functional Requirements**

Targets are release benchmarks to be tested on a supported desktop with four CPU cores, 8GB RAM, and a 10Mbps connection with 100ms round-trip delay, against a warmed staging service. Report results rather than presenting these as existing measurements.

**NFR-PERF-001 —** Reader/reference and ordinary mutations have p95 server latency ≤500ms excluding third-party identity/AI latency at 100 concurrent active users.

**NFR-PERF-002 —** Keyword search p95 server latency is ≤750ms on the launch corpus with 100 concurrent users; only bounded result pages are returned.

**NFR-PERF-003 —** Workspace usable-content time is ≤2 seconds for 20 nodes and ≤3 seconds for 100 nodes; a 500-node study provides focused/list content within five seconds.

**NFR-PERF-004 —** Desktop pan/drag achieves at least 30 frames per second in the visible 100-node benchmark; 500 nodes use focus/collapse/viewport strategies and must remain navigable without a main-thread freeze exceeding 200ms.

**NFR-PERF-005 —** Thread pagination supports 10,000 events per study without unbounded retrieval. Each visible page is 50 records and p95 retrieval ≤500ms.

**NFR-PERF-006 —** AI inputs never exceed the capability's configured token budget; summary requests target ≤12,000 input and ≤3,000 output tokens, with a 60-second request timeout.

**NFR-REL-001 —** Acknowledged mutations are durable; no action displays Saved before a transaction commits.

**NFR-REL-002 —** Proposed service availability target is 99.5% monthly for core study operations, excluding announced maintenance; AI failure is monitored separately.

**NFR-REL-003 —** Database backups support a proposed recovery point ≤24 hours and recovery time ≤4 hours, proven through a staging restore before launch.

**NFR-ACCESS-001 —** Core screens target WCAG 2.2 AA, including contrast, visible unobscured focus, accessible authentication, and non-drag alternatives. [W3C accessibility standard](https://www.w3.org/TR/WCAG22/)

**NFR-ACCESS-002 —** Keyboard users can create/read/edit nodes and edges through List View and dialogs, read the thread/summary, and navigate citations; canvas color or spatial arrangement is never the sole content representation.

**NFR-ACCESS-003 —** Reader and notes remain usable at 200% text resize and narrow viewport reflow; graph preview may use spatial scrolling with an equivalent list.

**NFR-SEC-001 —** Every private API operation enforces owner scope server-side; automated cross-user tests cover all nested resources and AI jobs.

**NFR-SEC-002 —** Rich text and URLs are validated and sanitized; scripts, unsafe schemes, and model-generated executable actions are rejected.

**NFR-PRIV-001 —** Production logs and analytics contain no Scripture queries, note bodies, source excerpts, questions, conclusions, email codes, or prompt/response text.

**NFR-PRIV-002 —** Private content is sent only after AI consent and only to a selected provider approved under section 29; consent revocation blocks new jobs and discards in-flight outputs where possible.

**NFR-SCALE-001 —** MVP is verified at 500 live nodes, 1,500 edges, 10,000 events per study, and 100 studies per account. These are supported sizes, not claims of arbitrary scale.

**NFR-SCALE-002 —** Safety caps are 2,000 live nodes and 6,000 live edges per study, 100,000 events per study, and 500MB derived account storage excluding shared Bible text; warn at 80% and preserve export/delete/read access at the cap. Event cap starts a new study-linked continuation rather than dropping history silently.

# **23. Data Model**

Use UUID primary IDs, timestamptz timestamps, explicit enum/check validation, and monotonically increasing integer revisions. Every private study-scoped table includes study\_id and owner\_id with composite foreign keys so a mismatched owner/study cannot be written. JSONB contains typed payloads and rich text; do not hide identity/status/relationships inside opaque JSON. PostgreSQL is the source of truth; a dedicated graph database is unnecessary for MVP.

## **Core relational schema**

User — id; normalized\_email unique; auth\_subject unique; display\_name nullable; timezone; default\_translation\_id; ai\_consent\_version and consent timestamp; ai\_enabled; analytics\_opt\_in; created\_at; deletion\_requested\_at. Provider identity contains credentials outside product tables. Index normalized\_email and auth\_subject. User → many Studies.

Study — id; owner\_id; title; description; starting\_reference\_id nullable; starting\_translation\_id nullable; original\_question\_node\_id nullable; main\_question\_node\_id nullable; last\_activity\_at; lifecycle active/archived/trashed; archived\_at; deleted\_at; content\_revision; revision; current\_summary\_id nullable; created\_at; updated\_at. Require starting reference/translation to be both present or both absent. Composite owner/id key supports child FKs. Index owner/lifecycle/last\_activity/id and title search. Original question is retained; changing main question does not rewrite it.

StudySession — id; study\_id; owner\_id; tab\_instance\_id; started\_at; last\_meaningful\_activity\_at; ended\_at; active\_branch\_id; last\_visit\_event\_id. Index study/started\_at. Session belongs to one study and browser tab; inactivity closes it without forcing a new Study.

ScriptureReference — id; canon\_id; versification\_id; book\_id; start\_verse\_id; end\_verse\_id; display\_label; normalized\_key unique per canon/versification. A range is contiguous within one book and validated against Verse coordinates. References have no private interpretation or Bible text and may be shared globally.

BibleTranslation — id; code; name; language; edition\_id; canon\_id; versification\_id; license\_status; rights\_record; attribution; source\_release; checksum; active. Edition rows are immutable releases; a new release gets a new identity. BibleBook defines code, aliases, sequence, and canon membership. BibleVerse — edition\_id, verse\_id, book/chapter/verse coordinates, text, checksum, search\_vector; unique edition/coordinate; B-tree edition/book/chapter/verse and GIN search\_vector. Corpus data is shared and read-only.

StudyNode — id; study\_id; owner\_id; type; title; body\_json/body\_plain; origin user/ai/external/scripture; adopted\_by nullable; created\_event\_id; payload\_schema\_version; payload\_json; revision; deleted\_at; created\_at; updated\_at. Type immutable. Scripture-specific columns scripture\_reference\_id, translation\_id/edition\_id, is\_canonical, canonical\_node\_id nullable. Question-specific columns question\_status and parent\_question\_id nullable. Observation columns observation\_kind and established\_by/at nullable. Conclusion current\_version\_id; Source source\_id. CHECK constraints ensure type-required columns and prohibit mismatched fields. Index study/type/deleted, study/updated, reference/owner, and study/question\_status. Partial unique index on study/reference/edition for live canonical Scripture nodes; noncanonical copies reference their canonical identity.

NodeVersion — id; node\_id; study\_id; owner\_id; version\_number; content\_json/plain; title; typed\_state; origin; created\_by; created\_at; change\_reason; previous\_version\_id. Unique node/version\_number. Commit a version for user content checkpoints; conclusions always version every semantic edit/status transition. Index node/version descending. Historical citations target version IDs, not mutable text.

StudyBranch — id; study\_id; owner\_id; root\_node\_id; parent\_branch\_id nullable; label; created\_at; deleted\_at. StudyBranchMember — branch\_id; node\_id; study\_id; owner\_id; added\_event\_id; unique branch/node. A node has many memberships; deleting a root marks the branch orphaned rather than deleting contents. Index branch/node and node/branch.

StudyEdge — id; study\_id; owner\_id; source\_node\_id; target\_node\_id; type; symmetric; note; origin; suggestion\_id nullable; accepted\_by nullable; created\_at; updated\_at; revision; deleted\_at. Composite FKs enforce same study. CHECK no self-edge; symmetric types use sorted endpoint IDs. Partial unique live index on study/source/target/type. Index live source and live target adjacency. Edge revisions and events preserve prior semantics and notes.

StudyEvent — id; study\_id; owner\_id; sequence bigint; session\_id nullable; event\_type; visibility; actor\_kind; node\_id/version\_id nullable; from\_node\_id nullable; to\_node\_id nullable; branch\_id nullable; parent\_visit\_event\_id nullable; payload\_json; schema\_version; client\_mutation\_id; correlation\_id; occurred\_at; recorded\_at. Unique study/sequence and owner/client\_mutation\_id. Allocate sequence through a transactional per-study counter. Index study/sequence, study/branch/sequence, node/sequence. Event snapshots are bounded to readable labels and permitted historical excerpts; no full repeated Bible chapters. Physical purge is permitted for retention/account deletion.

Note — id; study\_id; owner\_id; target\_node\_id nullable; target\_reference\_id nullable; phrase\_anchor\_json nullable; rich\_text\_json; plain\_text; revision; deleted\_at; created\_at; updated\_at. Target may be study-only or node-based, with phrase anchors only for Scripture references. GIN plain-text search and study/target index. NoteVersion stores checkpoint content, schema, version, and timestamps with unique note/version; retain last 100 checkpoints.

Annotation — id; study\_id; owner\_id; node\_id; edition\_id; anchor\_json; color\_token; label nullable; revision; deleted\_at. Anchor stores quote, per-verse code-point offsets, checksums, and unresolved state. Index node and reference. An annotation is not a separate verse node.

Conclusion detail — use StudyNode plus NodeVersion, not a standalone identity table. ConclusionVersion metadata includes status, established\_by/at, rationale, previous\_version\_id, and evidence\_edge\_ids. Immutable evidence snapshots include edge type/endpoints and referenced node versions, so later edge edits do not rewrite earlier reasoning. No separate Question table: use typed Question node fields and versions.

Source — id; study\_id; owner\_id; kind lexicon/commentary/church\_father/article/book/web/manual; title; author; work\_title; publication\_details; URL nullable; locator; excerpt nullable; excerpt\_kind quotation/paraphrase; rights\_note; accessed\_at nullable; verification\_status user\_entered/verified/unavailable; revision; deleted\_at. Enforce at least title plus URL or locator. Index study/kind. MVP stores user-entered citations only; no remote fetching. Source node references one Source. Later bibliographic deduplication can introduce shared catalog records without making private annotations public.

StudySummary — id; study\_id; owner\_id; schema\_version; basis\_content\_revision; context\_manifest\_id; model\_id; prompt\_version; structured\_output\_json; validation\_status; generated\_at; invalidated\_at nullable. Unique study/basis\_revision/prompt\_version/request ID where needed, index study/generated\_at. Eligible current pointer updates only in a transaction that checks the basis revision.

AISuggestion — id; study\_id; owner\_id; capability; status proposed/accepted/rejected/expired; proposal\_json; signature; basis\_content\_revision; dependency\_versions; context\_manifest\_id; model\_id; prompt\_version; created\_at; decided\_at; decided\_by; accepted\_artifact\_id nullable. Unique idempotent request/signature combination. Index study/status/created and rejected signature/dependency version. Expire when cited entity versions change; acceptance revalidates current prerequisites.

AIJob and AIResult — job id; owner/study; capability; request\_key; basis\_revision; consent\_version; state queued/running/succeeded/failed/cancelled; attempt\_count; available\_at; lease\_until; error\_code; token/cost counters. AIResult stores validated capability output and metadata. Index queued available\_at and expired lease. ContextManifest records selected entity/version IDs, omissions, token counts, and retrieval rules; do not duplicate private text in operational logs.

Tag and StudyTag — Tag id/owner/name/normalized\_name, unique owner/normalized\_name; StudyTag study/tag, unique pair with matching owner FKs. Index tag/study. Topic extraction is future work.

StudyViewState — owner/study/tab-device scope, selected node, active branch, reader reference/edition, viewport, pane state, collapsed branch IDs, positions (or NodePosition rows keyed owner/study/node), updated\_at. Separate view\_revision from content revision. View changes must not conflict with note text updates.

MutationReceipt — owner\_id; idempotency\_key; route; request\_hash; response/status; created\_at; expires\_at. Unique owner/key. Reject reuse with a different request body. Retain for seven days, matching the supported local queue lifetime. AuthDeletionJob and export jobs use the same lease pattern when asynchronous work is needed.

## **Integrity and deletion rules**

Node deletion soft-deletes connected edges and preserves content versions, events, and notes. Restore within 30 days restores eligible edges only if both endpoints are live and no uniqueness conflict exists; report conflicts and require manual resolution. If a canonical Scripture node is deleted while deliberate duplicates remain, promote the oldest live duplicate transactionally or restore/focus a surviving canonical instance; never leave two live canonical nodes.

If all live incoming supports and outgoing inference-from edges of a supported conclusion disappear, retain the user's status but clear establishment and set evidenceIncomplete=true with a visible warning. Do not automatically declare its theological meaning false. Reaffirmation requires live support again. Deleting the main question clears current main pointer but preserves the original question/version reference and resume fallback.

Study trash retains data for 30 days before physical purge. Historical references become tombstones after purge; any stored snippets of purged user content are removed/redacted. AI summaries citing deleted items are invalidated immediately. Account deletion purges all private tables and local caches according to section 29; shared Bible corpus remains.

# **24. API Surface**

Use REST JSON under /v1, generated OpenAPI, authenticated secure sessions, validated DTOs, and owner-scope authorization. IDs below are illustrative aliases; live requests use UUIDs. Date/time values use ISO timestamps. Mutation endpoints accept Idempotency-Key and entity expectedRevision; missing required revision returns 428. GET supports ETag where useful.

Study operations: GET /studies?state=active\&tag=\&q=\&sort=recent\&cursor=\&limit=50; POST /studies; GET/PATCH /studies/:id; POST /studies/:id/archive and /unarchive; DELETE /studies/:id (trash); POST /studies/:id/restore; GET /studies/:id/resume; PATCH /studies/:id/view-state. Tag and pin changes are validated study mutations.

Bible operations: GET /bible/translations; POST /bible/resolve with input and editionId; GET /bible/passages?referenceId=\&editionId=; GET /bible/search?q=\&mode=terms|phrase\&editionId=\&book=\&cursor=\&limit=25. Resolve response is normalized or returns ambiguous candidates; text comes only from licensed corpus/provider adapters.

Graph operations: GET /studies/:id/graph returns compact live-node/edge metadata plus positions, contentRevision, viewRevision, and cursor if needed; GET /studies/:id/nodes/:nodeId loads full content and versions; POST /studies/:id/nodes; PATCH/DELETE node; POST node/restore; POST node/duplicate; POST /studies/:id/edges; PATCH/DELETE edge; PATCH /studies/:id/positions batch max 100; POST /studies/:id/branches and PATCH branch/members. Graph content DTOs are library-independent.

Navigation and thread: POST /studies/:id/activity accepts a bounded verified visit/selection/search payload, sessionId, clientMutationId, origin/branch and parentVisitEventId; GET /studies/:id/events?cursor=\&limit=50\&filter=\&order=desc; GET /studies/:id/events/:eventId; GET node/reasoning returns deterministic links and historical version references. Never accept user-supplied arbitrary owner IDs or server sequence values.

Notes: POST /studies/:id/notes; GET/PATCH/DELETE /studies/:id/notes/:noteId; GET note/versions; POST note/restore; POST/PATCH/DELETE /studies/:id/annotations/:annotationId with corresponding collection create route. Conclusion content/status edits use node API and require changeReason on revision/abandonment.

AI: POST /studies/:id/ai/summary; POST /ai/relationships; POST /ai/passages; POST /ai/tensions; POST /ai/open-questions; POST /ai/branch-summary; POST /ai/reasoning; POST /ai/continuation. Each returns 202 jobId, basisRevision, and statusUrl. GET /studies/:id/ai/jobs/:jobId; GET /studies/:id/summary; GET /studies/:id/ai/suggestions; POST suggestion/accept or /reject. Poll every two seconds while visible, backing off to ten seconds; stop polling on unmount. WebSockets are not required.

Privacy/export: GET/PATCH /me/preferences and /me/ai-consent; POST /studies/:id/exports with format markdown|json; GET export status/download; POST /me/exports for account export; DELETE /me with recent OTP confirmation. A private signed export URL expires after 15 minutes; object expires after 24 hours. Small studies may export synchronously behind the same response contract.

## **Critical contract examples**

Study creation request:

{

  "title": "Conscience and the Holy Spirit",

  "startingPassage": {"input": "Rom 9:1", "editionId": "webp-v1"},

  "mainQuestion": "What is conscience?"

}

Success 201 returns studyId, contentRevision: 1, revision: 1, rootNodeId, questionNodeId, branchId, sessionId, and lastEventSequence. Root creations in this transaction share content revision 1.

Add Scripture request:

{

  "type": "scripture",

  "referenceId": "ref-rom-8-16",

  "editionId": "webp-v1",

  "duplicatePolicy": "focus\_existing",

  "navigation": {

    "fromNodeId": "node-rom-9-1",

    "branchId": "branch-conscience-spirit",

    "parentVisitEventId": "event-previous"

  },

  "expectedStudyRevision": 12,

  "clientMutationId": "uuid-client-operation"

}

Response: node, outcome created|focused\_existing|explicit\_duplicate, optional edge, visitEventId, eventSequence, contentRevision, studyRevision. A deduplicated intentional visit can succeed without changing contentRevision. A concurrency conflict that did not commit returns 409 with current revision; retry uses the same operation key after explicit reconciliation only when the request body matches. A changed reconciled request receives a new key.

Edge creation request contains sourceNodeId, targetNodeId, type: supports, note, expectedStudyRevision, and optional acceptedSuggestionId. 201 returns edge and revision; a duplicate returns 200 with outcome existing. For inference-from, explain in UI that the source claim is inferred from the target evidence, so clients do not reverse it accidentally.

Conclusion patch request contains expectedRevision, content, status, establishmentAction set|clear|unchanged, changeReason, evidenceEdgeIds. Response contains node, newVersionId, previousVersionId, and warnings. Server validates evidence requirements and updates the study content revision atomically.

Event response contains items \[{id, sequence, type, occurredAt, recordedAt, sessionId, displayText, targetRef, originRef, branchId, correlationId, delayedSync}\], nextCursor. Cursor encodes last sequence, filter, and order; new events do not cause repeated or skipped prior pages.

Summary response contains id, basisContentRevision, currentContentRevision, stale, status, structuredSummary, and coverageWarnings. AI outputs cannot set node statuses through this endpoint.

## **Consistent errors**

Error envelope: code, message, fieldErrors when relevant, retryable, correlationId, and currentRevision for conflicts. Use 400 malformed DTO, 401 unauthenticated, 404 absent or unauthorized private resource, 409 revision/uniqueness conflict, 413 payload too large, 422 invalid reference/state transition, 428 missing revision, 429 quota/rate limit with Retry-After, 503 dependency unavailable. Avoid exposing another user's entity existence through authorization error text.

# **25. AI Architecture**

Flow: user action → domain state and event committed → eligible job recorded → context assembler → owner-scoped graph/notes/events retrieval → immutable context manifest → prompt construction → provider call → structured validation → persisted AI artifact → freshness check → UI notification through polling. Core mutations never wait for a model response.

## **Context assembly**

Use deterministic retrieval for MVP. Always include objective/original question, current question, selected node and its pinned citations, active branch identity, and relevant user-established conclusions. Retrieve one-hop neighbors first, then selected two-hop evidence paths, up to 30 graph nodes; up to 20 recent meaningful events; up to 10 open questions; up to 10 relevant note excerpts. Candidate note relevance uses explicit node links and keyword matching. Passage text comes from the permitted corpus, not event copies. Source text is selected only when explicitly attached to the current reasoning.

The default summary budget is 12,000 input tokens: instructions/schema/trust rules 2,000; objective/current context 1,000; selected passage/graph evidence 4,000; conclusions/findings 2,000; notes/sources 1,500; events/open questions 1,000; safety reserve 500. Token counts are measured with the provider tokenizer before submission. Relationship requests target 4,000 input/1,000 output; tensions and reasoning 8,000/2,000; continuation 4,000/1,000. Output caps are provider enforced.

Preserve the objective, requested conclusion version, and required evidence before truncating optional context. Never cut a quoted verse midway while presenting it as complete; retrieve smaller explicit verse ranges or mark omission. If the set exceeds budget, use stored validated branch summaries with their underlying IDs, not recursively compressed untraceable prose. Add coverageWarnings for omitted branches. The UI states which branch or subset was summarized.

Previous related studies are excluded by default in MVP. Future retrieval requires cross-study consent and uses owner-scoped canonical references, never other users' notes. Scope is visible in the request panel.

## **Prompt and validation contracts**

Prompts label each block as Scripture, user statement, external quotation, prior AI artifact, or navigation event. Source text is untrusted data and cannot change system instructions. The model has no direct database mutation tools, arbitrary web browsing, shell execution, or email actions.

Validate output with shared JSON schemas/Zod: field types/lengths, allowed semantic enums, evidence eligibility, all IDs in the manifest, ownership, allowed verse ranges, exact Scripture quotations, source locator presence, and establishment rules. Interpretive disagreement cannot be solved by schema validation; apply behavioral evaluations separately. One constrained repair attempt may correct invalid JSON, using the same context and trust rules. If it still fails, persist failure metadata and publish no result.

A model quote must match the cited stored text; otherwise reject that item. Never “repair” a wrong reference by silently choosing a similar verse. Responses with unsupported certainty or uncited factual source claims fail evaluation/validation policy and offer a qualified retry or no result.

## **Jobs and cost controls**

Use PostgreSQL-backed leased jobs with SELECT FOR UPDATE SKIP LOCKED, a unique request key, retry schedule, and a two-minute lease renewed during work. Retry transient provider errors at most twice with jitter within the 60-second total request budget; respect Retry-After. A crashed job reclaims after lease expiration. No Redis or message broker in MVP.

Proposed validation limits: one running AI job per study, two per user; 20 user-triggered requests per hour; 50 total AI requests per user per day; maximum 30 automatic summaries per day. Account preferences show remaining request allowance. Monthly spend cap and per-request maximum token cost are configurable; at cap, pause AI and preserve core study functions. Automatic jobs coalesce rather than consuming one request per keystroke. Provider/model choice is configuration behind an adapter, with prompt, schema, timeout, and evaluation compatibility tracked per release.

# **26. System Architecture**

Frontend: Next.js, React, TypeScript, React Flow, Tiptap. Use React Flow for rendering/interactions and convert domain DTOs into view objects; library serialization is not the database schema. Use a query cache for server state and a lightweight client store for canvas selection, draft edits, and pending queue. Choose supported stable releases at implementation, pin exact versions in lockfiles, and test upgrades before release.

Backend: NestJS modular monolith with modules Identity, Study, BibleContent, Graph, Thread, Notes, AI, Exports, and Observability. Modules own writes to their domain tables through explicit services. Graph/Note services call Thread within the same transaction. AI retrieves read models and creates derived artifacts/suggestions; it cannot directly update user conclusions. REST contracts and schema validators are shared TypeScript packages without exposing database models to the browser.

PostgreSQL holds all domain state, corpus/search indexes, jobs, and idempotency receipts. Deploy a single API service plus a worker process from the same codebase. The worker uses the same database and permission-scoped domain services. This is a modular monolith with a background worker, not an initial microservice system.

S3-compatible storage is optional for expiring exports and later uploads. Markdown/JSON can stream directly for small studies. Vercel or a comparable host can serve the frontend; Railway or comparable managed hosting can serve API/worker/PostgreSQL. Deployment adapters and standard SQL/object storage keep these substitutable. Keep API and database near each other; require HTTPS and explicit allowed origins. Do not place long AI requests inside frontend serverless request handlers.

Cache public immutable corpus chunks by edition; mark private APIs no-store at intermediary caches. Cache graph metadata and latest valid summaries client-side by study/revision. Private content is never statically generated or put in shared CDN caches. Observe performance with memoized node components, stable callbacks, and branch visibility controls as recommended by the library. [React Flow performance guidance](https://reactflow.dev/learn/advanced-use/performance)

Graph snapshots initially fetch compact metadata for up to 500 nodes, with full note/source bodies loaded on selection. Above 500, fetch branch/focus metadata with cursor-based expansion and offer List View. Adjacency indexes support bounded traversals. Event history always paginates. Do not add vector search, Redis, an event broker, or another service until measured constraints justify it.

# **27. Autosave and State Management**

Apply optimistic creation/editing using stable client-generated UUIDs. Structural actions save immediately; text saves after 750ms idle with a maximum five-second delay; drag positions save after drag end with 300ms debounce; view state saves after one second idle. Serialize writes per entity, coalesce unsent text edits, and retain different entities' order where dependencies exist. A new edge waits for both nodes' acknowledged creation or is sent in an atomic command.

Save indicators: Saving, Saved, Waiting to Sync, Conflict Needs Review, and Save Failed. Display Saved only when all visible content mutations are acknowledged; view-state persistence may have a separate unobtrusive indicator. On route change flush pending changes; on page close use local persistence and a browser warning when unacknowledged content remains. Do not rely on unload network delivery.

Retries use idempotency keys and exponential backoff at approximately 1, 2, 4, 8, and 30 seconds with jitter. Pause on authentication errors and resume after reauthentication. Validation failures do not loop. Offline detection uses request outcomes as well as browser network state; “online” alone is not proof of successful save.

MVP is online first with bounded recovery: IndexedDB stores cached recently loaded studies and pending commands for up to seven days, 100 commands per study and 5MB per account. Default offline supports reading cached chapters/studies, existing note edits, question/thought capture, and cached-node position changes. AI, uncached Bible search, new-study server creation, export generation, and destructive operations require connection. New node IDs can be queued; edges to those nodes wait on acknowledged creation. No service-worker offline app installation guarantee exists until PWA work.

On reconnect, retrieve current entity revisions before replay. A mismatch returns 409; preserve local draft and show server/local text with Keep Server, Save My Version, or manually combine. Save My Version uses the current revision after explicit user choice, creates a fresh version, and logs the resolution. No automatic rich-text merge or CRDT. BroadcastChannel warns of another open editing tab and distributes acknowledged invalidations, but server revision checks remain authoritative across devices.

Reconcile optimistic errors by marking pending items, retaining content, and rolling back only the failed structural view if necessary. Failed deletion restores visibility. Clear private local caches on sign-out after offering to preserve unsynced drafts through a local download; a shared browser must not expose cached studies to the next account.

# **28. Error Handling & Failure Modes**

AI summary contradicts user notes: each item can be reported as misrepresentation. Hide that item locally in the current artifact, preserve notes, flag the artifact, and regenerate; never edit user conclusions. Include the offending item and cited IDs in a private support workflow only with user consent.

AI invents Scripture/source references: server validation rejects invalid references and uncited source assertions. Show no verified suggestion rather than a fabricated citation. Model knowledge of a commentary does not count as a retrieved source.

Bible API unavailable: MVP local corpus remains available. A later remote translation preserves cached text only if permitted, exposes availability, and lets the user choose another translation explicitly. Do not silently substitute text under the original translation label.

Node referenced by conclusions is deleted: warn with count of affected conclusions before deletion, preserve versions/events, invalidate summaries, and flag incomplete evidence. Restore or select replacement evidence; no automatic theological judgment.

Graph too large: default to focus/list, show hidden counts, load selected details lazily, and offer branch collapse. At safety cap permit review/export/delete while blocking additions with an explanation.

Duplicate verses: canonical partial unique constraint resolves concurrent adds; return existing node and record independent intentional visits. Deliberate duplicates are labeled and canonical visits stay predictable.

AI timeout/rate limit/provider outage: show retryable status, retain prior summary, honor quotas, and stop automatic retries after policy exhaustion. Core editing remains available.

Translation changes: preserve edition-specific nodes/anchors, clear active selection, and distinguish newly added translation nodes. Do not offset-map phrases across different texts.

Stale summary: invalidate on significant content changes; show basis revision/freshness; old jobs do not become current. Deletion removes deleted content from the current summary display while a new one is pending.

External source disappears: preserve permitted user-entered excerpt and citation metadata, mark URL unavailable when explicitly checked, and distinguish source availability from historical attribution. MVP does not crawl or repair URLs automatically.

Accidental deletion: offer Undo, trash recovery for 30 days, and warning for dependent evidence. Permanent account purge requires a recent OTP and clear description; ordinary deletion remains reversible during retention.

Network interruption/auth expiry: keep the local draft, show unsynced count, reauthenticate, and replay with idempotency and revisions. Never show a generic “saved” toast after only local persistence.

Corrupt content or invalid rich-text schema: reject server write, retain the prior valid version and local plain-text recovery; do not discard the study. Missing phrase anchor shows unresolved selection with original quote and edition.

AI consent revoked during generation: mark jobs cancelled, abort provider calls where supported, discard results, and do not start further calls. Already transmitted content cannot be recalled; explain this in consent settings.

# **29. Security & Privacy**

## **Authentication and authorization**

Use a managed email OTP provider with ten-minute codes, single use, maximum five verification attempts per code, and resend no sooner than 60 seconds. Avoid building credential storage. Add social login later if research shows meaningful demand. Session cookies are Secure, HttpOnly, SameSite=Lax; rotate on authentication, use seven-day inactivity and 30-day absolute expiry, and require recent OTP verification for deletion or sensitive email changes.

Owner checks apply to every study, node, note, event, export, suggestion, and job. IDs do not grant access. Query children through owner/study constraints. CSRF protection covers cookie-authenticated mutations; restrict CORS; parameterize SQL; validate all DTOs; require size limits. Rate-limit identity endpoints independently from normal APIs and AI quotas, using the managed provider plus PostgreSQL/in-process controls appropriate to the single API deployment.

Rich-text rendering uses an allowlist schema; external links accept HTTPS/HTTP only, open with safe rel attributes, and never execute fetched content. MVP performs no server-side arbitrary URL retrieval. Future uploads/web connectors require MIME checks, malware scanning, SSRF protections, sandboxed parsing, and untrusted-source handling before enablement. Prompt injection tests verify that quoted instructions cannot authorize tool actions or cross-user access.

Keep secrets in managed deployment secret stores; never ship provider credentials to the frontend. Enforce TLS in transit and managed storage encryption at rest. Apply dependency vulnerability review, migration review, audit alerts for authorization failures, and secret rotation. Do not claim end-to-end encryption: the server processes notes and optional AI context.

## **Private content and AI-provider handling**

Studies are private by default; there are no public links or collaboration permissions in MVP. Before enabling AI, clearly state what context may be sent, the selected provider, purpose, retention/training terms, processing region where known, and how to disable it. AI opt-in is optional and recorded with policy version. Study-specific disable overrides account enablement.

Provider selection is a launch gate: contract/API configuration must prohibit use of submitted study content for model training and define retention/deletion terms. Prefer zero-retention where available, but do not promise it without verified eligibility. If acceptable terms cannot be obtained, launch core study features with AI disabled rather than misrepresenting privacy. Record provider terms in deployment configuration and consent copy, and require renewed consent for materially changed handling.

Send only selected relevant content under the manifest, avoid account email/name and unrelated studies, and do not store prompts/responses in general logs. Persist validated results inside the user's authorized database scope. Operational logs use opaque job IDs, latency, token counts, status, and error category. Developers cannot browse production study text as routine debugging; support access requires explicit user permission and audited access.

## **Export and deletion**

MVP Markdown export gives a readable outline with Scripture references/attribution, notes, statuses, edge relationships, and a chronological thread. JSON export preserves full versioned structure, provenance, and permitted Scripture text. Account export aggregates studies and preferences. Future PDF/graph image export may add rendered layouts. Exports must respect each translation's rights, replacing prohibited bulk text with references rather than erasing user notes.

Deletion disables account access immediately and cancels jobs. Purge live private data and export objects within seven days; backup copies expire within 30 days under the proposed backup policy and are excluded from ordinary access. Restoring a backup reapplies deletion tombstones before serving users. Do not promise deletion from provider systems beyond the contracted capability; document provider retention in consent. Local cache deletion occurs on next authenticated device contact and sign-out; explain that previously downloaded exports remain under user control.

# **30. Analytics & Observability**

Product analytics are optional with an opt-out that does not impair use. Track pseudonymous user ID, study opaque ID, platform class, timestamp, event category, node counts, and consent-aware aggregate outcomes. Do not capture content, Bible reference values, search queries, tags, selected phrases, source URLs, or theological statements. StudyEvents are private product functionality; analytics events are a separate reduced dataset.

Useful events: study\_created, study\_resumed, scripture\_added, question\_added, edge\_created, question\_status\_changed, ai\_summary\_generated, ai\_suggestion\_accepted/rejected, study\_archived, export\_completed, and returned\_after\_elapsed\_bucket. Returned buckets use elapsed duration, not content. A meaningful study session requires at least one content capture or accepted relationship; scrolling does not count.

Proposed metrics: activation is a first study with three Scripture nodes, a question, a user-authored observation/conclusion, and one relationship within seven days; resume rate is the share of eligible activated users returning to a study on a later day within 14 days; median time to recover last question/passage comes from consented usability tasks; open-question resolution is user status changes per eligible open question; AI acceptance denominator excludes failed/invalid proposals and separately reports dismissals; compare task completion and agency errors with AI enabled/disabled.

Validation targets: at least 70% of observed target users resume the prior question/passage within 60 seconds; at least 80% correctly distinguish user conclusions from AI suggestions; ≥30% 14-day study return among activated pilot users. These are proposed decision thresholds; report cohort size and uncertainty, avoid a launch claim based on tiny samples. Average nodes/edges is diagnostic complexity, not success alone.

Operational metrics: core API error/latency by route, save failure/conflict rate, queue age, oldest AI job, token/cost spend, invalid-output rate, reference-validation failures, summary freshness, export failure, and database pool saturation. Trace with correlation IDs and content-redacted logs. Alert on sustained save error \>1% over 15 minutes, p95 latency over target for 15 minutes, oldest eligible job \>five minutes, authorization anomalies, and approaching spend cap. Retain operational metadata for 30 days and analytics aggregates for 90 days initially; policy changes must be disclosed.

# **31. Testing Strategy**

Unit tests cover reference aliases/boundaries, Unicode anchor conversion, duplicate identity, symmetric edge normalization, conclusion state transitions, revision checks, context ranking/budgeting, summary eligibility, and error mappings. Avoid testing only UI snapshots or mock happy paths.

Integration tests use real PostgreSQL with migrations. Verify atomic state/event writes, concurrent canonical-node creation, idempotency receipt/body mismatch, event sequence allocation, deletion/restore conflicts, supported-evidence invalidation, leased job reclaim, stale summary pointer updates, and account purge/tombstones. Validate full-text phrase behavior against punctuation and all-term searches.

API contract tests enforce DTO limits/enums, owner isolation for every nested route, 409 conflicts, 428 revisions, 429 Retry-After, archive read-only behavior, safe export access, and consent revocation. Generated clients and OpenAPI must match examples in this PRD.

E2E tests run the Romans conscience journey: start at Romans 9:1, add all listed passages, create two branches, revisit Romans 8:16 three times, record tentative/supported/challenged conclusions, accept/reject an edge proposal, revise a conclusion, reload, resume, and export. Add failure scenarios for network interruption, queue replay, second-tab editing, expired session, deleted evidence, stale summary, and disabled AI. Verify keyboard-only list/reader workflows, screen-reader focus, mobile capture, and narrow/200% layouts manually alongside automated accessibility checks.

Performance fixtures: 20/100/500 nodes, up to 1,500 edges, and 10,000 events with varied note sizes. Measure under the NFR environment, test focus mode and pagination, and record results in the release evidence. Test 2,000-node safety boundary without promising full-canvas performance.

AI evaluation uses a versioned set of at least 50 cases with deterministic schemas plus human review: valid/invalid references, uncertain parallels, multiple plausible interpretations, user statements quoted as user statements, establishment protection, contradiction false positives, incomplete reasoning, Unicode language questions, stale versions, and prompt injection inside sources. Include at least ten deliberately disputed interpretive cases reviewed by readers with more than one theological perspective.

Release gate: zero fabricated references displayed, zero unauthorized status changes, zero cross-user retrieval, 100% required evidence IDs resolvable, and at least 90% human-rated faithful summary items in the evaluation set. Review each failed case; aggregate score does not excuse an agency/privacy breach. Run evaluation when provider, model, prompt, schema, or retrieval rules change. Deterministic mocks test application flow; bounded live-provider runs test behavior and quality. Retain redacted evaluation fixtures, not real private studies without explicit consent.

# **32. MVP Acceptance Criteria**

MVP is complete only when the sixteen core capabilities in section 7 pass their requirements, the following integrated scenarios pass, rights/privacy gates are satisfied, and performance/accessibility evidence is recorded.

  - Given a new authenticated user, when they create the conscience study and navigate its passages, then graph structure and chronological visits remain distinct and reload correctly.
  - Given twenty or more visited passages, when the user revisits an existing exact Scripture range, then canonical graph deduplication and separate visit chronology both hold.
  - Given a supported conclusion, when evidence is challenged and the user revises it, then earlier versions and their evidence remain inspectable.
  - Given an AI suggestion, when accepted or rejected, then only explicit acceptance changes canonical content and provenance remains visible.
  - Given stale or invalid AI output, when rendered, then it cannot overwrite a current valid summary or be displayed as a user-established finding.
  - Given a closed browser and later return, when Resume is clicked, then saved question/branch/passage restore within one action even without AI.
  - Given connection loss during notes editing, when connectivity returns, then queued valid edits sync once and conflicts preserve the local draft.
  - Given another user's ID, when any private API/export/job is accessed, then access is refused with no content exposure.
  - Given desktop and phone users, when they read/capture/review, then the supported workflow is usable; phone users are not required to drag graph nodes.
  - Given a keyboard or screen-reader user, when they complete the core study workflow, then list-based node/edge operations provide equivalent information.
  - Given a study export and account deletion, when completed, then versioned provenance is portable and private-data retention follows the stated policy.
  - Given the launch corpus and AI provider settings, when release is reviewed, then content rights, attribution, consent text, and contracted provider handling are verified.

The launch review records unresolved blockers and measured NFR results. No critical authorization, data-loss, agency, or fabricated-citation defect is acceptable. AI can remain disabled for a core-product pilot only if clearly labeled; that pilot does not count as the full AI-enabled MVP acceptance.

# **33. Suggested Delivery Phases**

Phase 0 foundation: approve domain vocabulary and decisions; establish repository/shared schemas, authentication, owner isolation, migrations, idempotency, CI, observability, and content rights/import validation. Exit when cross-user access tests and corpus integrity pass.

Phase 1 deterministic study and reader: study lifecycle/library, reference and keyword search, rich notes/anchors, version checkpoints, and Markdown/JSON export skeleton. Build transaction/event infrastructure now so later features do not reconstruct history retrospectively. Exit with create/read/note/reload tests.

Phase 2 graph and reasoning: typed nodes/edges, canonical deduplication, question branches, conclusion versions/evidence constraints, canvas/list accessibility, layout/view state, undo, and deletion recovery. Exit with the non-AI conscience scenario.

Phase 3 thread and continuation: human-readable event projection, session grouping, event pagination, deterministic resume, mobile capture, optimistic save/local queue/conflict UX. Exit with repeated visits, offline recovery, and multi-day resume tests.

Phase 4 AI synthesis and suggestions: provider contract/consent, job worker, context budgets/manifests, structured validators, summaries, relationships, tensions, passages, open questions, reasoning narration, and continuation. Exit with evaluation gates and stale-output protection.

Phase 5 pilot readiness: performance fixtures, accessibility/manual usability, privacy/deletion/backup drill, error-state polish, operational alerts, and pilot metrics. Exit with section 32 acceptance evidence. Calendar estimates require team capacity; these dependency-ordered phases are not invented delivery commitments.

# **34. Linear Breakdown Strategy**

Create one Linear project for MVP and use the following epics. Do not create every engineering ticket from this document yet. Each later ticket should cite FR/NFR IDs, state affected contracts/tables, dependencies, concrete Given/When/Then criteria, and validation steps. Slice by usable vertical behavior rather than creating isolated UI/backend tasks without integration ownership.

## **Epic 1 Foundation and private identity**

Objective: authenticated private persistence. Scope: OTP, session handling, owner-scoped modules, migrations, DTO/OpenAPI schemas, CI, idempotency, logs. Dependencies: none. Ticket groups: repository contracts; identity; authorization fixtures; transaction/revision utilities; baseline monitoring.

## **Epic 2 Bible content reader and search**

Objective: deterministic rights-cleared Scripture access. Scope: edition/canon importer, integrity checks, aliases, reference lookup, chapter reader, term/phrase search, translation attribution, anchors. Dependencies: Epic 1. Ticket groups: rights record/import; parser/search; reader selections; failure/cache behavior. Rights review is a release gate.

## **Epic 3 Study lifecycle library and notes**

Objective: durable private investigations. Scope: creation/root transaction, title/questions/tags/pins/archive/trash, library, Tiptap notes and versions, reference/node links. Dependencies: Epics 1 and 2 for passage-backed creation. Ticket groups: study contracts; lifecycle/library; note editor; annotation persistence; state UX.

## **Epic 4 Graph and versioned reasoning**

Objective: inspectable connections and user-owned conclusions. Scope: typed nodes, edges, duplicate handling, branch memberships, conclusion evidence/status/versioning, React Flow/list, layout, focus/collapse, undo. Dependencies: Epics 1–3. Ticket groups: integrity/domain tests; graph API; canvas/list interactions; conclusion history; deletion impacts.

## **Epic 5 Activity thread and resumption**

Objective: preserve navigation and recover context. Scope: event taxonomy/correlation, session rules, visits/origins, thread pagination/projection, deterministic resume/home. Dependencies: Epic 1 transaction primitives; Epics 2–4 action hooks. Ticket groups: event capture; projection UI; sessions/context; resume journey. Instrument events alongside earlier features, then finish presentation here.

## **Epic 6 Autosave and responsive recovery**

Objective: trustworthy save and capture across device/network conditions. Scope: optimistic commands, local queue, idempotent replay, revisions/conflict dialog, cross-tab invalidation, responsive reading/capture. Dependencies: mutation contracts from Epics 1–5. Ticket groups: save coordinator; conflict/offline UI; mobile variants; reload/network E2E.

## **Epic 7 AI assistance and living synthesis**

Objective: useful derived assistance without agency loss. Scope: provider consent/contract, jobs, retrieval/context, validators, summaries, proposals, tensions, reasoning/continuation, quotas and evaluations. Dependencies: Epics 2–5 domain evidence and versions; Epic 6 freshness/display integration. Ticket groups: privacy/provider gate; job/context contracts; summary engine; suggestion acceptance; behavioral evaluation.

## **Epic 8 Export privacy and operational readiness**

Objective: portable data and recoverable production service. Scope: full Markdown/JSON exports, account deletion, retention/backup restore, alerts, performance, accessibility, pilot analytics. Dependencies: earlier entity schemas and AI artifacts. Ticket groups: export/deletion; restoration drill; performance/accessibility; consent-aware metrics; acceptance evidence.

Prioritize dependencies, assign a responsible role per epic when staffing is known, and treat risks as spike/validation tasks rather than quietly adding infrastructure. Generate detailed Linear tickets epic-by-epic after this PRD is approved; do not create issues as part of this document-writing task.

# **35. Engineering Risks**

Canonical ranges and translation editions can create false duplicates or incorrect anchors. Mitigation: immutable corpus versions, explicit versification, exact identity constraints, Unicode tests, and no inferred cross-edition offsets. Validation: import/parser fixtures and concurrent duplicate tests.

Automatic activity can flood the thread or misstate motive. Mitigation: meaningful action taxonomy, internal-only selection/search events, correlation grouping, origin/parent-visit data, and literal unknown-motive copy. Validation: observed study journeys plus 10,000-event pagination.

Graph performance may decline with dense connections. Mitigation: metadata-first loading, focus/collapse/list fallback, memoization, explicit layout and measured limits. Validation: 500-node/1,500-edge browser benchmarks before extending capacity.

AI context may omit crucial evidence or amplify earlier errors. Mitigation: required-evidence priority, context manifests, coverage warnings, typed citations, no untraceable recursive summaries, and human evaluations. Validation: large-branch and contradictory-evidence evaluation cases.

Concurrent edits or retries may lose notes or create duplicated records. Mitigation: per-entity revisions, idempotency receipts, local draft recovery, and transactional events. Validation: interrupted-network and multi-tab/device tests.

Privacy deletion may miss derived artifacts or backup restoration. Mitigation: owner-scoped purge inventory, deletion tombstones, and restore drills. Validation: integration test each entity and retained export/job artifact.

Licensing/provider behavior may constrain caching, AI, or exports. Mitigation: rights registry and provider contract gate, one public-domain corpus, explicit capability flags. Validation: product/legal review at release rather than assuming API access grants downstream rights.

# **36. Product Risks**

Users may experience the graph as extra work. Reduce required edge typing with neutral follow links and proposed semantics; offer list mode and test time spent capturing versus reading. If users abandon the workspace, prioritize reader/continuity improvements before more AI features.

Users may treat AI synthesis as theological authority. Keep origin, certainty, and adoption separate, use qualified language, show evidence, and test attribution comprehension. Do not use an “AI verified doctrine” label.

Automatic records may preserve destinations but miss purpose. Active questions/branches and optional “why I opened this” notes improve context; measure resume comprehension. Never fill the missing purpose with an invented narrative.

A single translation may limit appeal. Validate the continuity model with the rights-cleared corpus, collect demand for specific translations, and add licenses only when justified. Clearly explain the initial edition at onboarding.

A graph may reward collection over investigation. Surface open questions, revisions, and reasoning paths rather than passage-count achievements. Evaluate whether users resolve or thoughtfully defer questions, not whether they accumulate nodes.

Personally meaningful notes may deter AI use. Offer a complete deterministic workflow, voluntary provider consent, minimal retrieval, and usable export. Study return and save trust should be evaluated separately from AI acceptance.

Desktop focus may reduce capture opportunities. Provide mobile reader/questions/notes/resume immediately; validate native app demand before committing to another platform.

# **37. Future Opportunities**

Greek/Hebrew tools: dedicated Word Study nodes with lemma, transliteration, morphology, occurrence links, gloss provenance, and licensed lexicon entries; do not equate a gloss with a passage interpretation.

Early Church and commentary sources: rights-cleared bibliographic integrations, exact section locators, quotes versus paraphrases, citation verification, and theological perspective labels where supplied by the source. User uploads require safe ingestion and explicit rights handling.

Semantic search: add pgvector only if keyword/reference retrieval demonstrably misses useful connections; keep corpus citation verification and owner scope. A ranked match is relevance, not doctrinal proof.

Personal graph: passage-centered cross-study discovery with explained recurrence scores, topic groupings, competing conclusion versions, and deletion-aware projections.

Sharing and collaboration: explicit permissions, version/access revocation, consent for AI use by collaborators, and a new concurrency architecture. Evaluate collaborative editing before adding CRDTs.

Mobile/tablet/PWA: installability and rights-aware caching; tablet graph affordances; native capture companion if validated. Offline-first remains a separate synchronization project.

Exports: PDF research outline, accessible HTML, graph images with provenance legends, and reference-aware interchange/import. Future import should preserve origin/version identifiers and validate schema instead of replacing live studies indiscriminately.

# **38. Open Decisions**

Only matters requiring external validation remain open. These do not reopen the concrete MVP domain and UX decisions above.

AI provider and model: product/engineering must select a provider after reviewing retention/training/region terms, costs, and the evaluation suite. Default: adapter-based integration, AI disabled until terms and consent are verified. Required before AI-enabled pilot.

Launch audience and interpretation review group: product must recruit target deep-study readers and reviewers from more than one theological perspective. Default: an invited English-speaking single-user pilot. Required before validating summary quality and agency comprehension.

Launch territories and future corpus licenses: product/legal must confirm deployment scope and publisher rights records. Default: WEB Protestant edition only, no proprietary additions. Required before public release or adding a translation.

Brand name and business model: product must validate naming/trademark availability and whether paid AI limits are needed. Default: descriptive working name and no billing in MVP. Naming must resolve before public branding; pricing follows pilot cost/retention evidence.

Operational targets and staffing: engineering must confirm the proposed service/backup/spend targets against hosting capacity and actual team ownership. Default: the measurable NFR targets and dependency phases above; no promised launch date. Required before committing a delivery schedule and production service expectat3ions.
