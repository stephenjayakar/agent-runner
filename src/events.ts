import type { Response } from "express";
import type { Event, EventType } from "./types.js";

type SSEClient = {
  id: string;
  res: Response;
};

class EventBus {
  private clients: SSEClient[] = [];
  private eventLog: Event[] = [];

  addClient(id: string, res: Response): void {
    this.clients.push({ id, res });
    res.on("close", () => {
      this.clients = this.clients.filter((c) => c.id !== id);
    });
  }

  emit(type: EventType, data: unknown): void {
    const event: Event = {
      type,
      data,
      timestamp: Date.now(),
    };
    this.eventLog.push(event);

    // Keep last 1000 events
    if (this.eventLog.length > 1000) {
      this.eventLog = this.eventLog.slice(-1000);
    }

    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of this.clients) {
      try {
        client.res.write(payload);
      } catch {
        // Client disconnected
      }
    }
  }

  getRecentEvents(limit = 100): Event[] {
    return this.eventLog.slice(-limit);
  }
}

export const eventBus = new EventBus();
