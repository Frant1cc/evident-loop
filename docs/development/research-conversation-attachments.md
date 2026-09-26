# Research conversation attachments

The Research Workbench composer accepts one Markdown, TXT, DOCX, or text-based PDF per message. A message may contain only a file; the server supplies a default request to summarize it. The attachment belongs to the conversation message, not the shared knowledge base.

`POST /api/research/conversations/:conversationId/messages` continues to accept JSON for text-only messages. For an attachment, send `multipart/form-data` fields `content`, `toolPolicy` (JSON string), optional `skillId`, and `file`. The server validates the file with the existing knowledge format checks, parses it, and returns the usual queued-run response with `userMessage.attachment` metadata. Conversation detail also returns this metadata after a reload.

The upload limit follows `KNOWLEDGE_MAX_UPLOAD_BYTES` (20 MB by default). Extracted text is limited to 80,000 characters for a conversation attachment; larger documents must be split or added to the knowledge base. Scanned or encrypted PDFs remain unsupported. Only the extracted text and attachment metadata are persisted in SQLite; the original binary is not retained or downloadable. Deleting the conversation cascades to its attachment rows.

The current turn receives the extracted text as clearly marked document material. Later turns can also reference it from conversation history. The agent prompts tell the model to treat document text as source material rather than instructions. This is not a process sandbox: the existing PDF and DOCX parsers still run in the backend process. A future parsing worker can replace that execution boundary without changing the composer API.
