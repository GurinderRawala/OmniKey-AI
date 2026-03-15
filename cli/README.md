# Omnikey CLI

A command-line tool for onboarding users to the Omnikey open-source app and configuring their OPENAI_API_KEY.

## Features

- `omnikey onboard`: Interactive onboarding to set up your OPENAI_API_KEY.
- Accepts the `--open-ai-key` parameter for non-interactive setup.
- Supports self-hosted onboarding (generates a `.env` file for local backend with SQLite).

## Usage

```sh
# Install CLI globally (from this directory)
npm install -g .

# Onboard interactively (will prompt for OpenAI key and self-hosting)
omnikey onboard

# Or onboard non-interactively
omnikey onboard --open-ai-key YOUR_KEY

# Running the daemon will start the backend 
omnikey daemon --port 7071

# Kill the daemon 
omnikey kill-daemon --port 7071
```

If you choose self-hosted mode, a `.env` file will be generated in the project root with the necessary settings for running the backend locally with SQLite.

## Development

- Built with Node.js and TypeScript.
- Uses `commander` for CLI parsing and `inquirer` for prompts.
- Utilizes Yarn as the package manager.

## License

MIT