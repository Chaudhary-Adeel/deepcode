# DeepCode

AI coding assistant for VS Code powered by DeepSeek. Edit, refactor, and chat about your code directly in the editor.

![DeepCode Chat](assets/chat1.png)

## Features

- Chat with DeepSeek directly from the VS Code sidebar
- Read, edit, and refactor files in your workspace at runtime
- Native VS Code look and feel

![DeepCode Chat Example](assets/chat2.png)

## Setup

1. Install the extension (see [Building from Source](#building-from-source) or install from a `.vsix`)
2. Open the DeepCode panel in the activity bar
3. Set your DeepSeek API key when prompted

![Setup](assets/setup.png)

## Building from Source

### Prerequisites

- [Node.js](https://nodejs.org/) (LTS recommended)
- npm (comes with Node.js)
- [@vscode/vsce](https://github.com/microsoft/vscode-vsce) (installed automatically by the build script)

### Quick Build

Run the build script to compile and package in one step:

```bash
chmod +x build.sh
./build.sh
```

The script will:
1. Check prerequisites (Node.js, npm, vsce)
2. Install dependencies (`npm install`)
3. Compile TypeScript (`npm run compile`)
4. Run lint checks (non-blocking)
5. Package the extension into a `.vsix` file

### Manual Build

If you prefer to run each step yourself:

```bash
# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Package the VSIX
npx @vscode/vsce package --no-dependencies --allow-missing-repository
```

Then install the resulting `.vsix`:

```bash
code --install-extension deepcode-1.0.0.vsix
```

## Contributing

Contributions are welcome. Here's how to get started:

1. **Fork** the repo and create a branch from `main`
2. **Make your changes** — keep PRs focused on a single concern
3. **Test** — run the extension with F5 and verify your changes work
4. **Compile clean** — run `npm run compile` and fix any TypeScript errors
5. **Submit a PR** with a clear description of what you changed and why

### Guidelines

- Follow the existing code style (no linter config yet — just match what's there)
- Keep the UI native to VS Code — use `var(--vscode-*)` CSS tokens, not custom colors
- Don't add dependencies unless absolutely necessary (the extension currently has zero runtime deps)
- API keys and secrets must never be logged, committed, or sent anywhere except the DeepSeek API
- Test with both dark and light VS Code themes

### Areas where help is needed

- Unit tests
- Support for additional LLM providers (OpenAI, Anthropic, Ollama)

## License

MIT

## Author

**Muhammad Adeel** — [chaudhar1337@gmail.com](mailto:chaudhar1337@gmail.com)