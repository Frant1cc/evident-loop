import { createServer } from 'node:http';

const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  response.setHeader('Content-Type', 'application/json');
  if (request.url === '/v1/embeddings') {
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    response.end(JSON.stringify({ data: inputs.map((_input, index) => ({ index, embedding: [0.1, 0.2, 0.3] })) }));
    return;
  }
  if (request.url === '/v1/chat/completions') {
    const systemPrompt = body.messages?.[0]?.content ?? '';
    if (/ArtifactAgent content planner|presentation design-system author|presentation HTML designer/.test(systemPrompt)) {
      response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '' } }] }));
      return;
    }
    if (body.tools?.some((tool) => tool.function?.name === 'start_document_generation')
      && !body.messages?.some((message) => message.role === 'tool')) {
      response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{
        id: 'smoke-document-request',
        type: 'function',
        function: { name: 'start_document_generation', arguments: JSON.stringify({
          deliverables: [
            { documentType: 'presentation', formats: ['pptx'] },
            { documentType: 'longform', formats: ['docx', 'pdf'] }
          ]
        }) }
      }] } }] }));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
    response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Deployment smoke test completed.' } }] }));
    return;
  }
  response.statusCode = 404;
  response.end('{}');
});
server.listen(4000, '0.0.0.0');
