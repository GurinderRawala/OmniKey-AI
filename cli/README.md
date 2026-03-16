# Omnikey CLI

A command-line tool for onboarding users to the Omnikey open-source app and configuring their OPENAI_API_KEY.

## About OmnikeyAI (macOS)

OmnikeyAI is a productivity tool for macOS that helps you quickly rewrite selected text using OpenAI. It consists of a macOS menu bar app and a TypeScript backend daemon. The CLI allows you to configure and run the backend daemon, onboard users, and manage your OpenAI API key with ease. Once set up, you can select any text on your Mac and trigger rewrite commands directly from your desktop.

- For more details about the app and its features, see the [main README](https://github.com/GurinderRawala/OmniKey-AI).
- Download the latest macOS app here: [Download OmniKeyAI for macOS](https://omnikeyai-saas-fmytqc3dra-uc.a.run.app/macos/download)

## Features

- `omnikey onboard`: Interactive onboarding to set up your OPENAI_API_KEY.
- Accepts the `--open-ai-key` parameter for non-interactive setup.
- Configure and run the backend daemon for the macOS app.

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

## Development

- Built with Node.js and TypeScript.
- Uses `commander` for CLI parsing and `inquirer` for prompts.
- Utilizes Yarn as the package manager.

## License

MIT
