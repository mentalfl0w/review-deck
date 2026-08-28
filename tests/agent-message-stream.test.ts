/**
 * Focused verification of the Paseo Agent SDK's `send` semantics for the
 * editing flows: processProjectReview and the revise actions hand the prompt
 * to the SELECTED workspace agent's workflow fire-and-forget via
 * `handle.send(prompt)` — exactly one send_agent_message_request on the
 * selected agent, and NO wait_for_finish_request (processing time is
 * unbounded; results appear in the agent's conversation, never awaited).
 *
 * Method: drive the real public client (`createPaseoClient`) against an
 * in-memory fake daemon transport that validates every server frame with the
 * protocol's own WSOutboundMessageSchema and answers with schema-valid
 * responses. The captured client frames show exactly which agent id each RPC
 * targets, so the stream ownership is observable, not assumed.
 *
 * Run: node tests/agent-message-stream.test.ts
 */
import assert from "node:assert/strict";
import { createPaseoClient } from "@getpaseo/client";
import { WSOutboundMessageSchema } from "@getpaseo/protocol/generated/validation/ws-outbound.aot";

type Frame = { type: string; [key: string]: unknown };

function createFakeDaemon() {
  const sent: Frame[] = [];
  let onMessage: ((data: unknown, isBinary: boolean) => void) | null = null;
  let onOpen: (() => void) | null = null;

  function pushServerMessage(message: unknown) {
    // Every server frame must pass the protocol's own outbound validation;
    // a shape mistake fails here instead of being silently ignored.
    const frame = WSOutboundMessageSchema.parse(message);
    onMessage?.(JSON.stringify(frame), false);
  }

  function respondTo(frame: Frame) {
    // Session RPCs arrive wrapped in a "session" envelope; hello/ping are bare.
    const message =
      frame.type === "session" && typeof frame.message === "object" && frame.message !== null
        ? (frame.message as Frame)
        : frame;
    switch (message.type) {
      case "hello":
        pushServerMessage({
          type: "session",
          message: { type: "status", payload: { status: "server_info", serverId: "fake-daemon" } },
        });
        break;
      case "ping":
        pushServerMessage({ type: "pong" });
        break;
      case "send_agent_message_request":
        pushServerMessage({
          type: "session",
          message: {
            type: "send_agent_message_response",
            payload: {
              requestId: message.requestId,
              agentId: message.agentId,
              accepted: true,
              error: null,
            },
          },
        });
        break;
      case "wait_for_finish_request":
        pushServerMessage({
          type: "session",
          message: {
            type: "wait_for_finish_response",
            payload: {
              requestId: message.requestId,
              status: "idle",
              final: null,
              error: null,
              lastMessage: "fake daemon reply",
            },
          },
        });
        break;
      default:
        break;
    }
  }

  return {
    sent,
    transportFactory: () => ({
      send: (data: string) => {
        const frame = JSON.parse(data) as Frame;
        // Store the unwrapped RPC so assertions can read type/agentId/text.
        sent.push(
          frame.type === "session" && typeof frame.message === "object" && frame.message !== null
            ? (frame.message as Frame)
            : frame,
        );
        respondTo(frame);
      },
      close: () => {},
      onMessage: (handler: (data: unknown, isBinary: boolean) => void) => {
        onMessage = handler;
        return () => {
          onMessage = null;
        };
      },
      onOpen: (handler: () => void) => {
        onOpen = handler;
        return () => {
          onOpen = null;
        };
      },
      onClose: () => () => {},
      onError: () => () => {},
    }),
    open: () => onOpen?.(),
  };
}

async function main() {
  const daemon = createFakeDaemon();
  // transportFactory is part of the DaemonClient config surface; the public
  // PaseoClientConfig type does not declare it, so the test casts.
  const client = createPaseoClient({
    url: "ws://fake-daemon.invalid/ws",
    clientId: "agent-stream-test",
    reconnect: { enabled: false },
    transportFactory: daemon.transportFactory,
  } as Parameters<typeof createPaseoClient>[0] & { transportFactory: (options: unknown) => unknown });
  try {
    const connecting = client.connect();
    daemon.open();
    await connecting;

    // The selected workspace agent: whatever id Review Deck resolves from More
    // (or the project-queue picker) is passed to agents.ref() untouched.
    const agentId = "ws-agent-1";
    const handle = client.agents.ref(agentId);

    // 1. send(): posts exactly one visible user message to the ref'd agent's
    //    conversation; it does not wait for the turn. This is the RPC the
    //    editing flows rely on (processProjectReview and the revise actions
    //    call handle.send(prompt) / agents.ref(agentId).send(prompt)).
    const beforeSend = daemon.sent.length;
    await handle.send("process every saved review comment as one task");
    const sendFrames = daemon.sent.slice(beforeSend);
    assert.equal(sendFrames.length, 1, "send() must emit exactly one RPC");
    assert.equal(sendFrames[0].type, "send_agent_message_request");
    assert.equal(sendFrames[0].agentId, agentId, "send() must target the ref'd agent");
    assert.equal(sendFrames[0].text, "process every saved review comment as one task");

    // 2. The editing flow NEVER waits for the agent: no wait_for_finish_request
    //    may be emitted — processing time is unbounded and results appear in
    //    the agent's conversation, not in Review Deck.
    const waitFrames = daemon.sent.filter((frame) => frame.type === "wait_for_finish_request");
    assert.equal(waitFrames.length, 0, "the editing flow must never wait for the agent");

    // 3. Every message RPC in the whole session targeted the one ref'd agent:
    //    no second stream, no detached agent id.
    const everySend = daemon.sent.filter((frame) => frame.type === "send_agent_message_request");
    assert.ok(everySend.length >= 1, "expected at least the send() message RPC");
    assert.ok(
      everySend.every((frame) => frame.agentId === agentId),
      "all message RPCs must target the selected agent",
    );

    console.log("agent-message-stream: all assertions passed");
    console.log("verdict: agents.ref(<selected agent id>).send(prompt) emits exactly one");
    console.log("         send_agent_message_request targeting that agent id — the same RPC the workspace");
    console.log("         UI uses to post a user message — and NO wait_for_finish_request. The prompt");
    console.log("         therefore lands in the SELECTED workspace agent's message stream (fire-and-forget),");
    console.log("         never awaited; the agent's replies stay visible there for the user to copy.");
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
