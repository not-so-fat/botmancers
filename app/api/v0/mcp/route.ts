// NOT-491: the Botmancers MCP bridge (Streamable HTTP, lib/mcp-http).
import { handleMcpMethodNotAllowed, handleMcpPost } from '@/lib/mcp-http';

export async function POST(request: Request) {
  return handleMcpPost(request);
}

export async function GET() {
  return handleMcpMethodNotAllowed();
}

export async function DELETE() {
  return handleMcpMethodNotAllowed();
}
