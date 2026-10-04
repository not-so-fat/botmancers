import { NextResponse } from 'next/server';
import { bots, conversations, queue } from '@/lib/db';
import { processQueue } from '@/lib/agent';
import { IMPORT_SCHEMA_VERSION } from '@/app/api/import-capabilities/route';
import { createHash } from 'crypto';

export interface BotImportRequest {
  schema_version: string;
  operation_id: string;
  source_provider: string;
  template_id: string;
  template_url: string;
  bot: {
    name: string;
    title?: string;
    description?: string;
    avatar?: string;
  };
}

export interface BotImportVerification {
  matches: boolean;
  differences: {
    name?: { expected: string; actual: string };
    title?: { expected: string; actual: string };
    description?: { expected: string; actual: string };
    avatar?: { expected: string | undefined; actual: string | undefined };
    source_provider?: { expected: string; actual: string };
    template_id?: { expected: string; actual: string };
    template_url?: { expected: string; actual: string };
    import_schema_version?: { expected: string; actual: string };
  };
}

function computeBodyHash(body: BotImportRequest): string {
  const normalized = {
    schema_version: body.schema_version,
    source_provider: body.source_provider,
    template_id: body.template_id,
    template_url: body.template_url,
    bot: {
      name: body.bot.name,
      title: body.bot.title || '',
      description: body.bot.description || '',
      avatar: body.bot.avatar || null,
    },
  };
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function validateImportRequest(body: unknown): { valid: false; errors: string[] } | { valid: true; data: BotImportRequest } {
  const errors: string[] = [];

  if (!body || typeof body !== 'object') {
    return { valid: false, errors: ['Request body must be a JSON object'] };
  }

  const req = body as Record<string, unknown>;

  if (!req.schema_version || typeof req.schema_version !== 'string') {
    errors.push('Field "schema_version" is required and must be a string');
  } else if (req.schema_version !== IMPORT_SCHEMA_VERSION) {
    errors.push(`Unknown schema version "${req.schema_version}". Supported version: "${IMPORT_SCHEMA_VERSION}"`);
  }

  if (!req.operation_id || typeof req.operation_id !== 'string' || !req.operation_id.trim()) {
    errors.push('Field "operation_id" is required and must be a non-empty string');
  }

  if (!req.source_provider || typeof req.source_provider !== 'string' || !req.source_provider.trim()) {
    errors.push('Field "source_provider" is required and must be a non-empty string');
  }

  if (!req.template_id || typeof req.template_id !== 'string' || !req.template_id.trim()) {
    errors.push('Field "template_id" is required and must be a non-empty string');
  }

  if (!req.template_url || typeof req.template_url !== 'string' || !req.template_url.trim()) {
    errors.push('Field "template_url" is required and must be a non-empty string');
  }

  if (!req.bot || typeof req.bot !== 'object') {
    errors.push('Field "bot" is required and must be an object');
  } else {
    const bot = req.bot as Record<string, unknown>;
    
    if (!bot.name || typeof bot.name !== 'string' || !bot.name.trim()) {
      errors.push('Field "bot.name" is required and must be a non-empty string');
    }

    if (bot.title !== undefined && typeof bot.title !== 'string') {
      errors.push('Field "bot.title" must be a string if provided');
    }

    if (bot.description !== undefined && typeof bot.description !== 'string') {
      errors.push('Field "bot.description" must be a string if provided');
    }

    if (bot.avatar !== undefined && typeof bot.avatar !== 'string') {
      errors.push('Field "bot.avatar" must be a string if provided');
    }

    const unsupportedFields = ['memories', 'skills', 'routines', 'integrations', 'model', 'temperature', 'max_tokens'];
    for (const field of unsupportedFields) {
      if (bot[field] !== undefined) {
        errors.push(`Field "bot.${field}" is not supported in the current Botmancers model`);
      }
    }
  }

  const topLevelUnsupportedFields = ['marketplace_data', 'grok_metadata', 'raw_payload'];
  for (const field of topLevelUnsupportedFields) {
    if (req[field] !== undefined) {
      errors.push(`Field "${field}" is not supported. Use only Botmancers-compatible import format`);
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    data: req as unknown as BotImportRequest,
  };
}

function verifyImport(request: BotImportRequest, bot: typeof bots extends { getById: (id: string) => infer B } ? B : never): BotImportVerification {
  if (!bot) {
    return {
      matches: false,
      differences: {},
    };
  }

  const differences: BotImportVerification['differences'] = {};

  if (bot.name !== request.bot.name) {
    differences.name = { expected: request.bot.name, actual: bot.name };
  }

  const expectedTitle = request.bot.title || '';
  if (bot.title !== expectedTitle) {
    differences.title = { expected: expectedTitle, actual: bot.title };
  }

  const expectedDescription = request.bot.description || '';
  if (bot.description !== expectedDescription) {
    differences.description = { expected: expectedDescription, actual: bot.description };
  }

  const expectedAvatar = request.bot.avatar || undefined;
  const actualAvatar = bot.avatar || undefined;
  if (expectedAvatar !== actualAvatar) {
    differences.avatar = { expected: expectedAvatar, actual: actualAvatar };
  }

  if (bot.source_provider !== request.source_provider) {
    differences.source_provider = { expected: request.source_provider, actual: bot.source_provider || '' };
  }

  if (bot.template_id !== request.template_id) {
    differences.template_id = { expected: request.template_id, actual: bot.template_id || '' };
  }

  if (bot.template_url !== request.template_url) {
    differences.template_url = { expected: request.template_url, actual: bot.template_url || '' };
  }

  if (bot.import_schema_version !== request.schema_version) {
    differences.import_schema_version = { expected: request.schema_version, actual: bot.import_schema_version || '' };
  }

  return {
    matches: Object.keys(differences).length === 0,
    differences,
  };
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    
    const validation = validateImportRequest(body);
    if (!validation.valid) {
      return NextResponse.json(
        { error: 'Invalid import request', details: validation.errors },
        { status: 400 }
      );
    }

    const importRequest = validation.data;
    const requestHash = computeBodyHash(importRequest);

    const existingBot = bots.getByImportOperationId(importRequest.operation_id);

    if (existingBot) {
      const existingRequestForVerification: BotImportRequest = {
        schema_version: existingBot.import_schema_version || IMPORT_SCHEMA_VERSION,
        operation_id: importRequest.operation_id,
        source_provider: existingBot.source_provider || '',
        template_id: existingBot.template_id || '',
        template_url: existingBot.template_url || '',
        bot: {
          name: existingBot.name,
          title: existingBot.title,
          description: existingBot.description,
          avatar: existingBot.avatar || undefined,
        },
      };
      const existingHash = computeBodyHash(existingRequestForVerification);

      if (existingHash !== requestHash) {
        return NextResponse.json(
          { 
            error: 'Conflict: operation_id already used with different content',
            operation_id: importRequest.operation_id,
            existing_bot_id: existingBot.id,
          },
          { status: 409 }
        );
      }

      return NextResponse.json({
        bot: existingBot,
        created: false,
        verification: verifyImport(importRequest, existingBot),
      });
    }

    const bot = bots.createFromImport(
      {
        name: importRequest.bot.name.trim(),
        title: importRequest.bot.title || '',
        description: importRequest.bot.description || '',
        avatar: importRequest.bot.avatar,
      },
      {
        source_provider: importRequest.source_provider,
        template_id: importRequest.template_id,
        template_url: importRequest.template_url,
        import_schema_version: importRequest.schema_version,
        import_operation_id: importRequest.operation_id,
        import_timestamp: Date.now(),
      }
    );

    const conversation = conversations.getByBotId(bot.id);
    if (conversation) {
      queue.enqueue(conversation.id, bot.id);
      processQueue().catch(console.error);
    }

    return NextResponse.json({
      bot,
      created: true,
      verification: verifyImport(importRequest, bot),
    });
  } catch (error) {
    console.error('Error importing bot:', error);
    return NextResponse.json({ error: 'Failed to import bot' }, { status: 500 });
  }
}
