export interface AnnotationProjectionRefreshConsumer {
  readonly name: string;
  readonly refresh: (filePath: string) => Promise<void> | void;
}

export interface AnnotationProjectionRefreshIssue {
  readonly cause: unknown;
  readonly consumerName: string;
  readonly filePath: string;
}

export class AnnotationProjectionCoordinator {
  private readonly consumers: readonly AnnotationProjectionRefreshConsumer[];
  private readonly onIssue: (issue: AnnotationProjectionRefreshIssue) => void;

  constructor(input: {
    readonly consumers: readonly AnnotationProjectionRefreshConsumer[];
    readonly onIssue?: (issue: AnnotationProjectionRefreshIssue) => void;
  }) {
    this.consumers = input.consumers;
    this.onIssue = input.onIssue ?? (() => undefined);
  }

  async refresh(filePaths: readonly string[]): Promise<void> {
    const distinctPaths = [...new Set(filePaths)];
    await Promise.all(
      this.consumers.flatMap((consumer) =>
        distinctPaths.map(async (filePath) => {
          try {
            await consumer.refresh(filePath);
          } catch (cause) {
            try {
              this.onIssue({ cause, consumerName: consumer.name, filePath });
            } catch {
              // Diagnostics are observational and cannot block the remaining projections.
            }
          }
        }),
      ),
    );
  }
}
