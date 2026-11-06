# Project Refactoring & Deployment Specification
## Search + Weather Agentic AI Assistant

Act as a Senior AI Engineer, Python Backend Architect, Next.js Engineer, and DevOps Engineer.

Your task is to refactor the existing repository into a production-quality, deployable full-stack Agentic AI application.

Repository: https://github.com/riskymind/search-weather-agentic-ai-assistant

The final application must use:

- Frontend: Next.js (App Router), TypeScript, Tailwind CSS.
- Backend: FastAPI, Python 3.11+.
- Agent orchestration: LangChain (use a modern, supported tool-calling architecture).
- LLM: OpenAI.
- Web search: Tavily.
- Weather provider: Weatherstack.
- Local development: Docker Compose.
- Frontend deployment: Vercel-compatible.
- Backend deployment: Render-compatible, with Docker deployment support.

Do not simply create a new application from scratch. First understand the existing codebase and preserve its original functionality.

---

# PHASE 1: CODEBASE AUDIT AND PLANNING

Before modifying anything:

1. Inspect the entire repository.
2. Read:
   - README.md
   - app.py
   - requirements.txt
   - research/agent_demo.ipynb
   - .gitignore
3. Identify all existing dependencies and their purposes.
4. Understand how the current LangChain agent works.
5. Identify how Tavily Search is integrated.
6. Identify how Weatherstack is integrated.
7. Identify the existing prompts, agent execution logic, and tool definitions.
8. Identify deprecated APIs, outdated dependencies, and potential security problems.
9. Identify functionality that should be preserved.

Create a detailed `spec.md` containing:

- Current architecture assessment.
- Problems with the existing implementation.
- Proposed architecture.
- Target folder structure.
- Backend API contracts.
- Agent execution workflow.
- Frontend component architecture.
- Environment variables.
- Testing strategy.
- Deployment strategy.
- Implementation milestones.

IMPORTANT:

Do not modify the codebase until the initial audit and implementation plan are complete.

Do not discard the research notebook. Preserve it and update documentation if necessary.

---

# PHASE 2: BACKEND REFACTORING (FASTAPI)

Move all AI-related business logic into the FastAPI backend.

Use a modular, maintainable architecture.

Target structure:

backend/
    app/
        api/
            v1/
                routes/
                    agent.py
                    health.py
                router.py

        agents/
            weather_agent.py
            prompts.py

        tools/
            search_tool.py
            weather_tool.py

        services/
            agent_service.py

        schemas/
            agent.py
            common.py

        core/
            config.py
            logging.py

        main.py

    tests/
        unit/
        integration/

    pyproject.toml
    Dockerfile
    .env.example

## 2.1 Application configuration

Use Pydantic Settings for configuration management.

Support these environment variables:

OPENAI_API_KEY=
TAVILY_API_KEY=
WEATHER_API_KEY=
OPENAI_MODEL=
APP_ENV=
FRONTEND_URL=
LOG_LEVEL=

Requirements:

- Never hardcode credentials.
- Never expose API keys to the frontend.
- Validate required environment variables.
- Provide meaningful configuration errors.
- Support development and production environments.
- Keep `.env` out of Git.
- Provide `.env.example`.

Use a configurable OpenAI model rather than hardcoding the model throughout the application.

## 2.2 Weather tool

Refactor the existing `get_weather_data()` function into an independent, reusable weather tool.

Requirements:

- Accept a city as input.
- Fetch current weather from Weatherstack.
- Use HTTPS.
- Use HTTPX for asynchronous HTTP requests where appropriate.
- Configure connection and response timeouts.
- Validate the city parameter.
- Handle invalid cities.
- Handle provider errors.
- Handle missing API credentials.
- Handle malformed API responses.
- Avoid exposing API keys in logs or error messages.

Return structured weather data containing:

- City
- Country
- Temperature in Celsius
- Weather description
- Humidity
- Wind speed
- Observation time

Use Pydantic schemas for structured responses.

Do not fabricate weather information when the provider fails.

## 2.3 Web search tool

Refactor the Tavily integration into `search_tool.py`.

Requirements:

- Accept a natural-language search query.
- Return structured search results.
- Include relevant titles, URLs, and content snippets.
- Support configurable maximum results.
- Handle empty search results.
- Handle API failures and timeouts.
- Avoid exposing credentials.

The agent must be able to use search results to answer questions about current information.

## 2.4 Agent architecture

Refactor the existing ReAct agent into a modern tool-calling agent.

Preserve the original capabilities:

1. Web search.
2. Weather retrieval.
3. Multi-step reasoning and tool selection.

The agent should intelligently decide which tool to invoke.

Example scenarios:

Question: What is the weather in Lagos?

Expected behavior:
- Identify a weather-related request.
- Invoke the weather tool.
- Return the weather information.

Question: Who is the president of Nigeria?

Expected behavior:
- Identify an information retrieval request.
- Invoke Tavily Search.
- Summarize relevant search results.

Question: Find the capital of Kenya and tell me its current weather.

Expected behavior:
- Search for the capital of Kenya.
- Identify the resulting city.
- Retrieve weather for that city.
- Combine the results into one coherent answer.

Important:

- Do not force every query through a tool.
- Allow the LLM to answer general questions directly when appropriate.
- Do not invent tool results.
- Handle tool failures gracefully.
- Implement bounded tool execution to prevent infinite loops.
- Use structured tool outputs.
- Keep prompts separate from business logic.
- Make the agent easy to extend with additional tools.

Do not expose private chain-of-thought or internal model reasoning to the user. Instead, expose safe execution events such as tool selection, tool execution status, and completed results.

## 2.5 Agent service

Create `agent_service.py` to coordinate agent execution.

Responsibilities:

- Accept user queries.
- Execute the agent.
- Manage conversation context where supported.
- Collect tool execution events.
- Format the final answer.
- Handle execution failures.
- Return structured results.

Keep the service independent of FastAPI route definitions.

Do not introduce unnecessary database infrastructure for the initial version. If persistent conversation storage is implemented, use a clearly separated repository/service layer and document the storage choice.

## 2.6 FastAPI endpoints

Implement:

GET /api/v1/health

Example response:

{
  "status": "healthy",
  "service": "search-weather-agent",
  "version": "1.0.0"
}

POST /api/v1/agent/query

Request:

{
  "message": "Find the capital of Nigeria and tell me its weather",
  "session_id": null
}

Response:

{
  "session_id": "generated-session-id",
  "answer": "The capital of Nigeria is Abuja...",
  "tool_events": [
    {
      "tool": "tavily_search",
      "status": "completed",
      "summary": "Found information about Nigeria's capital"
    },
    {
      "tool": "weather",
      "status": "completed",
      "summary": "Retrieved current weather for Abuja"
    }
  ]
}

The response is illustrative. Implement appropriate Pydantic response schemas.

Also implement:

POST /api/v1/agent/stream

Use Server-Sent Events (SSE) for streaming agent activity and the final response.

Requirements:

- Send structured events.
- Stream safe tool execution updates.
- Stream answer tokens when supported by the chosen agent implementation.
- Handle client disconnections.
- Send an explicit completion event.
- Send structured error events.
- Avoid leaking internal reasoning or credentials.

Use appropriate HTTP status codes and consistent error responses.

Configure CORS to allow the configured frontend origin only.

---

# PHASE 3: NEXT.JS FRONTEND

Completely replace the Streamlit interface with a modern Next.js application.

Technology:

- Next.js App Router.
- TypeScript.
- Tailwind CSS.
- React.
- Lucide React icons.
- React hooks for state management.
- Native Fetch API for backend communication.

Use stable, compatible dependency versions.

## 3.1 UI/UX direction

Build a polished AI assistant interface.

Design inspiration:

- ChatGPT.
- Perplexity.
- Modern AI research assistants.

The application should look like a real AI product rather than a basic demonstration.

Design characteristics:

- Clean, minimal interface.
- Responsive layout.
- Premium typography.
- Well-spaced components.
- Subtle animations.
- Beautiful message bubbles.
- Clear visual hierarchy.
- Accessible controls.
- Loading and error states.
- Support desktop, tablet, and mobile.

Implement dark mode and light mode if practical.

## 3.2 Main application layout

Create the following layout:

Sidebar:
- Application logo and name.
- New conversation button.
- Conversation list.
- Clear conversation action.
- Settings section.

Main chat area:
- Welcome screen.
- Assistant introduction.
- Suggested prompts.
- User messages.
- Assistant responses.
- Tool execution activity.
- Loading indicators.
- Error states.

Chat input:
- Multiline input.
- Send button.
- Enter to submit.
- Shift + Enter for a new line.
- Disabled state while submitting where appropriate.
- Responsive input container.

Suggested prompts:

1. What's the current weather in Lagos?
2. Find the latest technology news.
3. Find the capital of Kenya and its current weather.
4. Research the latest developments in artificial intelligence.

These should be clickable and automatically populate or submit a query.

## 3.3 Chat components

Create reusable components:

- ChatLayout
- Sidebar
- ChatHeader
- WelcomeScreen
- ChatMessage
- ChatInput
- ToolExecutionCard
- SearchResultCard
- WeatherCard
- LoadingIndicator
- ErrorMessage
- SuggestedPrompts

Avoid placing the entire application inside one component.

## 3.4 Weather presentation

When the assistant retrieves weather data, render a structured weather card.

Display:

- Location.
- Temperature.
- Weather description.
- Humidity.
- Wind speed.
- Observation time.

Use appropriate weather icons.

The card should be visually distinct from normal assistant messages.

## 3.5 Search result presentation

When Tavily is used, display relevant sources beneath the answer.

Each source should contain:

- Page title.
- URL/domain.
- Short content snippet.
- Clickable external link.

Use safe external-link handling.

## 3.6 Agent activity visualization

Display safe tool execution events.

Example:

- Analyzing your request.
- Searching the web.
- Retrieving weather information.
- Preparing your answer.
- Completed.

Use animated status indicators.

Do not display hidden chain-of-thought, internal prompts, or private model reasoning.

## 3.7 Frontend API integration

Create a centralized API client.

Suggested files:

frontend/src/lib/api.ts
frontend/src/lib/config.ts
frontend/src/types/agent.ts

Use:

NEXT_PUBLIC_API_URL=

Requirements:

- Centralize backend requests.
- Handle HTTP errors.
- Handle network failures.
- Support JSON responses.
- Support SSE streaming.
- Abort requests when appropriate.
- Avoid duplicating fetch logic across components.
- Keep backend contracts synchronized with TypeScript interfaces.

Do not put backend secrets in NEXT_PUBLIC environment variables.

## 3.8 Conversation management

Implement a clean session-based conversation experience.

Requirements:

- Generate or receive a session ID.
- Keep messages associated with their session.
- Allow starting a new conversation.
- Maintain the current conversation during navigation.
- Show previous conversations if persistence is implemented.
- Clearly distinguish user and assistant messages.

Do not pretend conversations are persisted across devices if they are only stored in browser memory or local storage.

---

# PHASE 4: TESTING

Create meaningful tests for both applications.

## Backend tests

Use pytest and appropriate mocking.

Test:

- FastAPI health endpoint.
- Agent query endpoint.
- Weather tool success.
- Weather tool invalid city.
- Weather provider timeout.
- Tavily search success.
- Tavily search failure.
- Agent tool selection.
- Multi-tool execution.
- Invalid request payloads.
- Missing configuration.
- SSE event structure.
- Agent execution errors.

Mock external API calls. Unit tests must not require actual OpenAI, Tavily, or Weatherstack credentials.

## Frontend tests

Use an appropriate testing setup such as Vitest and React Testing Library.

Test:

- Welcome screen rendering.
- Message submission.
- Assistant response rendering.
- Loading states.
- Error states.
- Suggested prompt interaction.
- Weather card rendering.
- Search result rendering.
- Tool activity updates.

Run production builds and resolve all TypeScript errors.

---

# PHASE 5: DOCKER AND LOCAL DEVELOPMENT

Create Dockerfiles for both applications.

Create a root-level docker-compose.yml.

Requirements:

- Separate frontend and backend services.
- Backend accessible on port 8000.
- Frontend accessible on port 3000.
- Configure service networking correctly.
- Use environment variables.
- Support local development.
- Include health checks.
- Use appropriate production Docker build stages.
- Avoid copying `.env` files into images.
- Avoid running production containers as root where practical.

Expected command:

docker compose up --build

Expected URLs:

Frontend:
http://localhost:3000

Backend:
http://localhost:8000

Swagger documentation:
http://localhost:8000/docs

Health:
http://localhost:8000/api/v1/health

Make sure the frontend can communicate with the backend correctly when running inside Docker and when running directly on the host.

---

# PHASE 6: DEPLOYMENT PREPARATION

Prepare the project for independent deployment.

## Frontend: Vercel

Requirements:

- Ensure Next.js production build succeeds.
- Configure the API base URL using environment variables.
- Document Vercel deployment.
- Configure production environment variables.
- Ensure no backend secrets are exposed.
- Ensure the frontend uses the deployed FastAPI URL.

## Backend: Render

Create a production-ready backend Dockerfile.

Requirements:

- Use a supported Python base image.
- Install dependencies efficiently.
- Start FastAPI using Uvicorn.
- Bind to 0.0.0.0.
- Use the platform-provided PORT environment variable.
- Expose a health endpoint.
- Configure production CORS.
- Log application errors appropriately.
- Ensure startup does not depend on local development files.

Document how to:

1. Create a Render web service.
2. Connect the GitHub repository.
3. Configure the backend root directory.
4. Configure environment variables.
5. Deploy the backend.
6. Verify its health endpoint.
7. Configure the deployed frontend to use the backend URL.

Also document an alternative Docker-based deployment approach.

Do not claim that deployment has succeeded unless an actual deployment has been performed and verified.

---

# PHASE 7: DOCUMENTATION

Rewrite README.md to reflect the new architecture.

Include:

1. Project overview.
2. Features.
3. Architecture diagram.
4. Technology stack.
5. Project structure.
6. Prerequisites.
7. Environment variables.
8. Local development without Docker.
9. Local development with Docker.
10. API documentation.
11. Example API requests.
12. Testing instructions.
13. Frontend deployment.
14. Backend deployment.
15. Troubleshooting.
16. Future improvements.

Create:

- backend/.env.example
- frontend/.env.example
- backend/README.md if useful
- frontend/README.md if useful
- deployment instructions.

---

# PHASE 8: ENGINEERING STANDARDS

Follow these standards throughout the refactoring:

1. Use clean architecture and separation of concerns.
2. Keep business logic outside API routes.
3. Use type hints throughout Python.
4. Use Pydantic for request and response validation.
5. Use TypeScript strictly.
6. Avoid unnecessary abstractions.
7. Avoid giant components and giant service classes.
8. Avoid duplicated code.
9. Handle errors explicitly.
10. Never hardcode secrets.
11. Use structured logging.
12. Add useful docstrings.
13. Keep dependencies minimal.
14. Prefer asynchronous I/O for external API calls.
15. Ensure frontend and backend contracts remain consistent.
16. Pin or constrain dependency versions appropriately.
17. Follow secure coding practices.

Do not introduce Redis, PostgreSQL, Kubernetes, authentication, or other infrastructure without a clear requirement. Keep the first production version straightforward.

---

# PHASE 9: IMPLEMENTATION WORKFLOW

Work incrementally.

Do not attempt to refactor everything in one massive operation.

Follow this sequence:

Milestone 1: Repository audit and spec.md.

Milestone 2: Backend architecture and configuration.

Milestone 3: Weather and search tools.

Milestone 4: Agent orchestration and FastAPI endpoints.

Milestone 5: Backend unit and integration tests.

Milestone 6: Next.js project initialization and UI.

Milestone 7: Frontend API integration and SSE streaming.

Milestone 8: Frontend tests and production build.

Milestone 9: Docker and Docker Compose.

Milestone 10: Deployment configuration and documentation.

After each milestone:

- Run relevant tests.
- Run linting and type checks.
- Fix errors before proceeding.
- Review the changes.
- Update spec.md with completion status.

If an architectural decision needs to change, document why.

Do not silently remove existing features.

Do not overwrite user work or delete research files.

Do not commit, push, publish, or deploy without explicit authorization.

---

# FINAL ACCEPTANCE CRITERIA

The project is considered complete only when:

[ ] Streamlit has been replaced with Next.js.

[ ] FastAPI runs independently.

[ ] Tavily search works through the backend.

[ ] Weatherstack works through the backend.

[ ] The agent can intelligently select tools.

[ ] Multi-tool queries work.

[ ] The frontend communicates with FastAPI.

[ ] Chat responses render correctly.

[ ] Tool execution activity is visible.

[ ] Weather results render as structured cards.

[ ] Search results render with clickable citations.

[ ] SSE streaming works.

[ ] Backend tests pass.

[ ] Frontend tests pass.

[ ] Next.js production build succeeds.

[ ] Docker Compose starts both applications.

[ ] Environment variables are documented.

[ ] Production Dockerfiles are ready.

[ ] Vercel deployment instructions exist.

[ ] Render deployment instructions exist.

[ ] README.md is updated.

[ ] No credentials are committed.

[ ] No unresolved critical errors remain.

At completion, provide a detailed engineering report containing:

1. Original architecture.
2. New architecture.
3. Files created.
4. Files modified.
5. Features preserved.
6. Features improved.
7. Tests executed and their results.
8. Production build results.
9. Docker verification results.
10. Remaining limitations.
11. Exact deployment steps.

IMPORTANT FINAL INSTRUCTION:

Prioritize a working, tested, deployable application over unnecessary architectural complexity.

Do not mark a feature complete simply because its files exist. Verify its actual behavior.

Begin with repository inspection and the creation of spec.md. Then proceed milestone by milestone.