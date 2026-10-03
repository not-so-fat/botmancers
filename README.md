# Botmancers v0

The smallest cloud-hosted teammate web app: create bots, chat, organize in groups, with state persisted in SQLite.

## What is v0?

Botmancers v0 is a minimal web application that lets you:
- Create AI bots with custom personalities
- Chat with individual bots
- Create groups and add multiple bots
- Send messages to groups where bots can interact
- Persist all state in a local SQLite database

## How to run

1. Install dependencies:
```bash
npm install
```

2. Set your OpenAI API key in the environment:
```bash
export OPENAI_API_KEY=your-key-here
```

Optional configuration:
```bash
export OPENAI_BASE_URL=https://openrouter.ai/api/v1  # optional
export OPENAI_MODEL=gpt-3.5-turbo                    # optional
```

3. Start the development server:
```bash
npm run dev
```

4. Open http://localhost:43123

The app will work without an API key, but bots will return error messages instead of responses.
