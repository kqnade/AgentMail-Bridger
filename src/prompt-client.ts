export type PromptDeliveryStage = "full" | "enter";

export interface PromptClient {
  sendPrompt(
    target: string,
    text: string,
    stage?: PromptDeliveryStage,
  ): Promise<void>;
}

export class PromptTextDeliveredError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PromptTextDeliveredError";
  }
}
