import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { isDefined } from 'twenty-shared/utils';
import { WorkspaceActivationStatus } from 'twenty-shared/workspace';
import { In, Not, Repository } from 'typeorm';

import {
  MessageChannelSyncStage,
  MessageChannelType,
} from 'twenty-shared/types';
import { SentryCronMonitor } from 'src/engine/core-modules/cron/sentry-cron-monitor.decorator';
import { ExceptionHandlerService } from 'src/engine/core-modules/exception-handler/exception-handler.service';
import { InjectMessageQueue } from 'src/engine/core-modules/message-queue/decorators/message-queue.decorator';
import { Process } from 'src/engine/core-modules/message-queue/decorators/process.decorator';
import { Processor } from 'src/engine/core-modules/message-queue/decorators/processor.decorator';
import { MessageQueue } from 'src/engine/core-modules/message-queue/message-queue.constants';
import { MessageQueueService } from 'src/engine/core-modules/message-queue/services/message-queue.service';
import { WorkspaceEntity } from 'src/engine/core-modules/workspace/workspace.entity';
import {
  MessagingMessagesImportJob,
  type MessagingMessagesImportJobData,
} from 'src/modules/messaging/message-import-manager/jobs/messaging-messages-import.job';
import { isThrottled } from 'src/modules/connected-account/utils/is-throttled';
import { MessageChannelEntity } from 'src/engine/metadata-modules/message-channel/entities/message-channel.entity';
import { toIsoStringOrNull } from 'src/utils/date/toIsoStringOrNull';

export const MESSAGING_MESSAGES_IMPORT_CRON_PATTERN = '*/1 * * * *';

@Processor(MessageQueue.cronQueue)
export class MessagingMessagesImportCronJob {
  private readonly logger = new Logger(MessagingMessagesImportCronJob.name);

  constructor(
    @InjectRepository(WorkspaceEntity)
    private readonly workspaceRepository: Repository<WorkspaceEntity>,
    @InjectMessageQueue(MessageQueue.messagingQueue)
    private readonly messageQueueService: MessageQueueService,
    private readonly exceptionHandlerService: ExceptionHandlerService,
    @InjectRepository(MessageChannelEntity)
    private readonly messageChannelRepository: Repository<MessageChannelEntity>,
  ) {}

  @Process(MessagingMessagesImportCronJob.name)
  @SentryCronMonitor(
    MessagingMessagesImportCronJob.name,
    MESSAGING_MESSAGES_IMPORT_CRON_PATTERN,
  )
  async handle(): Promise<void> {
    const activeWorkspaces = await this.workspaceRepository.find({
      where: {
        activationStatus: WorkspaceActivationStatus.ACTIVE,
      },
    });

    const activeWorkspaceIds = activeWorkspaces.map(
      (workspace) => workspace.id,
    );

    if (activeWorkspaceIds.length === 0) {
      return;
    }

    const pendingMessageChannels = await this.messageChannelRepository
      .find({
        where: {
          workspaceId: In(activeWorkspaceIds),
          isSyncEnabled: true,
          syncStage: MessageChannelSyncStage.MESSAGES_IMPORT_PENDING,
          type: Not(MessageChannelType.EMAIL_GROUP),
        },
      })
      .catch((error): MessageChannelEntity[] => {
        this.exceptionHandlerService.captureExceptions([error]);

        return [];
      });

    const messageChannelsToSchedule = pendingMessageChannels.filter(
      (messageChannel) =>
        !isThrottled(
          toIsoStringOrNull(messageChannel.syncStageStartedAt),
          messageChannel.throttleFailureCount,
          toIsoStringOrNull(messageChannel.throttleRetryAfter),
        ),
    );

    const throttledCount =
      pendingMessageChannels.length - messageChannelsToSchedule.length;

    if (throttledCount > 0) {
      this.logger.log(`Skipped ${throttledCount} throttled message channels`);
    }

    if (messageChannelsToSchedule.length === 0) {
      return;
    }

    const workspaceIdByMessageChannelId = new Map(
      messageChannelsToSchedule.map((messageChannel) => [
        messageChannel.id,
        messageChannel.workspaceId,
      ]),
    );

    const updateResult = await this.messageChannelRepository
      .createQueryBuilder()
      .update()
      .set({
        syncStage: MessageChannelSyncStage.MESSAGES_IMPORT_SCHEDULED,
        syncStageStartedAt: new Date(),
      })
      .where({
        id: In([...workspaceIdByMessageChannelId.keys()]),
        isSyncEnabled: true,
        syncStage: MessageChannelSyncStage.MESSAGES_IMPORT_PENDING,
      })
      .returning('id')
      .execute();

    const updatedIds = updateResult.raw.map((row: { id: string }) => row.id);

    for (const messageChannelId of updatedIds) {
      const workspaceId = workspaceIdByMessageChannelId.get(messageChannelId);

      if (!isDefined(workspaceId)) {
        continue;
      }

      try {
        await this.messageQueueService.add<MessagingMessagesImportJobData>(
          MessagingMessagesImportJob.name,
          { workspaceId, messageChannelId },
        );
      } catch (error) {
        this.exceptionHandlerService.captureExceptions([error], {
          workspace: { id: workspaceId },
        });
      }
    }
  }
}
