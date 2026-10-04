# Repository Guidelines

## Project Status & Purpose

This workspace is currently empty and is not initialized as a Git repository. The intended project is a performant MCP server that exposes content from `cloudmaker97/claude-fuer-deutsches-recht` through targeted queries for Claude and ChatGPT. No implementation language, framework, or package manager has been selected yet.

## Project Structure & Module Organization

When adding the implementation, organize server code in `src/`, automated tests in `tests/`, and setup documentation in `docs/`. Keep downloaded source content and generated search indexes separate from application code. Document their actual locations once implemented, and exclude reproducible caches from version control.

## Build, Test, and Development Commands

There are currently no build, test, development, or lint commands. When choosing the toolchain, add reproducible commands to the root README and package configuration. Explain installation, index generation, local server startup, and test execution. Do not document commands as working until they have been verified.

## Coding Style & Naming Conventions

Follow the selected language's standard formatter and linter, and commit their configuration. Keep indentation consistent within each file. Use descriptive module names, explicit MCP tool names, and small functions with clear responsibilities. Separate content ingestion, indexing, query execution, and transport handling. Prefixes optimized for github e.g. fix(web): Title.

## Testing Guidelines

No testing framework or coverage threshold exists yet. Add tests for search relevance, bounded responses, invalid arguments, missing content, and MCP protocol behavior. Use descriptive test names and follow the chosen framework's discovery conventions. Performance changes should include reproducible benchmarks with corpus size and environment details.

## Commit & Pull Request Guidelines

No Git history is available to establish existing conventions. Use short, imperative commit subjects such as `Add indexed skill search`. Pull requests should explain the change, relevant issues, validation performed, and any configuration or compatibility impact. Never coauthor commit messages, pull requests etc.

## Security & Configuration

Keep credentials out of source control. Validate content paths and query limits. Document required environment variables and authentication before exposing a network endpoint.
