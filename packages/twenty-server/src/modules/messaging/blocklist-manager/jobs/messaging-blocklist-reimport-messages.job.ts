import { Scope } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { type ObjectRecordDeleteEvent } from 'twenty-shared/database-events';
import { In, Not, Repository } from 'typeorm';

import { Process } from 'src/engine/core-modules/message-queue/decorators/process.decorator';
import { Processor } from 'src/engine/core-modules/message-queue/decorators/processor.decorator';
import { MessageQueue } from 'src/engine/core-modules/message-queue/message-queue.constants';
import { UserWorkspaceEntity } from 'src/engine/core-modules/user-workspace/user-workspace.entity';
import { ConnectedAccountEntity } from 'src/engine/metadata-modules/connected-account/entities/connected-account.entity';
import { MessageChannelEntity } from 'src/engine/metadata-modules/message-channel/entities/message-channel.entity';
import { WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';
import { buildSystemAuthContext } from 'src/engine/twenty-orm/utils/build-system-auth-context.util';
import { type WorkspaceEventBatch } from 'src/engine/workspace-event-emitter/types/workspace-event-batch.type';
import { type BlocklistWorkspaceEntity } from 'src/modules/blocklist/standard-objects/blocklist.workspace-entity';
import { MessageChannelSyncStatusService } from 'src/modules/messaging/common/services/message-channel-sync-status.service';
import { type WorkspaceMemberWorkspaceEntity } from 'src/modules/workspace-member/standard-objects/workspace-member.workspace-entity';
import { MessageChannelSyncStage } from 'twenty-shared/types';

export type BlocklistReimportMessagesJobData = WorkspaceEventBatch<
  ObjectRecordDeleteEvent<BlocklistWorkspaceEntity>
>;

@Processor({
  queueName: MessageQueue.messagingQueue,
  scope: Scope.REQUEST,
})
export class BlocklistReimportMessagesJob {
  constructor(
    private readonly workspaceOrmManager: WorkspaceOrmManager,
    @InjectRepository(MessageChannelEntity)
    private readonly messageChannelRepository: Repository<MessageChannelEntity>,
    @InjectRepository(ConnectedAccountEntity)
    private readonly connectedAccountRepository: Repository<ConnectedAccountEntity>,
    @InjectRepository(UserWorkspaceEntity)
    private readonly userWorkspaceRepository: Repository<UserWorkspaceEntity>,
    private readonly messagingChannelSyncStatusService: MessageChannelSyncStatusService,
  ) {}

  @Process(BlocklistReimportMessagesJob.name)
  async handle(data: BlocklistReimportMessagesJobData): Promise<void> {
    const workspaceId = data.workspaceId;

    const authContext = buildSystemAuthContext(workspaceId);

    await this.workspaceOrmManager.executeInWorkspaceContext(
      async () => {
        const workspaceMemberRepository =
          this.workspaceOrmManager.getRepository<WorkspaceMemberWorkspaceEntity>(
            'workspaceMember',
            { shouldBypassPermissionChecks: true },
          );

        const workspaceMemberIds = [
          ...new Set(
            data.events.map(
              (eventPayload) =>
                eventPayload.properties.before.workspaceMemberId,
            ),
          ),
        ];

        const workspaceMembers =
          workspaceMemberIds.length > 0
            ? await workspaceMemberRepository.find({
                where: { id: In(workspaceMemberIds) },
              })
            : [];

        const workspaceMemberByIdMap = new Map(
          workspaceMembers.map((workspaceMember) => [
            workspaceMember.id,
            workspaceMember,
          ]),
        );

        const userWorkspaces =
          workspaceMembers.length > 0
            ? await this.userWorkspaceRepository.find({
                where: {
                  userId: In(workspaceMembers.map(({ userId }) => userId)),
                  workspaceId,
                },
              })
            : [];

        const userWorkspaceByUserIdMap = new Map(
          userWorkspaces.map((userWorkspace) => [
            userWorkspace.userId,
            userWorkspace,
          ]),
        );

        const connectedAccounts =
          userWorkspaces.length > 0
            ? await this.connectedAccountRepository.find({
                where: {
                  userWorkspaceId: In(userWorkspaces.map(({ id }) => id)),
                  workspaceId,
                },
              })
            : [];

        const connectedAccountsByUserWorkspaceIdMap = new Map<
          string,
          ConnectedAccountEntity[]
        >();

        for (const connectedAccount of connectedAccounts) {
          const existing = connectedAccountsByUserWorkspaceIdMap.get(
            connectedAccount.userWorkspaceId,
          );

          if (existing) {
            existing.push(connectedAccount);
          } else {
            connectedAccountsByUserWorkspaceIdMap.set(
              connectedAccount.userWorkspaceId,
              [connectedAccount],
            );
          }
        }

        const messageChannels =
          connectedAccounts.length > 0
            ? await this.messageChannelRepository.find({
                where: {
                  connectedAccountId: In(
                    connectedAccounts.map(({ id }) => id),
                  ),
                  syncStage: Not(
                    MessageChannelSyncStage.MESSAGE_LIST_FETCH_PENDING,
                  ),
                  workspaceId,
                },
              })
            : [];

        const messageChannelsByConnectedAccountIdMap = new Map<
          string,
          MessageChannelEntity[]
        >();

        for (const messageChannel of messageChannels) {
          const existing = messageChannelsByConnectedAccountIdMap.get(
            messageChannel.connectedAccountId,
          );

          if (existing) {
            existing.push(messageChannel);
          } else {
            messageChannelsByConnectedAccountIdMap.set(
              messageChannel.connectedAccountId,
              [messageChannel],
            );
          }
        }

        for (const workspaceMemberId of workspaceMemberIds) {
          const workspaceMember =
            workspaceMemberByIdMap.get(workspaceMemberId);

          if (!workspaceMember) {
            continue;
          }

          const userWorkspace = userWorkspaceByUserIdMap.get(
            workspaceMember.userId,
          );

          if (!userWorkspace) {
            continue;
          }

          const connectedAccountIds = (
            connectedAccountsByUserWorkspaceIdMap.get(userWorkspace.id) ?? []
          ).map((connectedAccount) => connectedAccount.id);

          if (connectedAccountIds.length === 0) {
            continue;
          }

          const messageChannelsForMember = connectedAccountIds.flatMap(
            (connectedAccountId) =>
              messageChannelsByConnectedAccountIdMap.get(
                connectedAccountId,
              ) ?? [],
          );

          await this.messagingChannelSyncStatusService.resetAndMarkAsMessagesListFetchPending(
            messageChannelsForMember.map(
              (messageChannel) => messageChannel.id,
            ),
            workspaceId,
          );
        }
      },
      authContext,
      { lite: true },
    );
  }
}
