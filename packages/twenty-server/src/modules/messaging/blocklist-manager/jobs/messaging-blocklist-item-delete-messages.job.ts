import { Scope } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { type ObjectRecordCreateEvent } from 'twenty-shared/database-events';
import { MessageParticipantRole } from 'twenty-shared/types';
import { isDefined } from 'twenty-shared/utils';
import { And, Any, ILike, In, Not, Or, Repository } from 'typeorm';

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
import { type MessageChannelMessageAssociationWorkspaceEntity } from 'src/modules/messaging/common/standard-objects/message-channel-message-association.workspace-entity';
import { type MessageParticipantWorkspaceEntity } from 'src/modules/messaging/common/standard-objects/message-participant.workspace-entity';
import { MessagingMessageCleanerService } from 'src/modules/messaging/message-cleaner/services/messaging-message-cleaner.service';
import { type WorkspaceMemberWorkspaceEntity } from 'src/modules/workspace-member/standard-objects/workspace-member.workspace-entity';

export type BlocklistItemDeleteMessagesJobData = WorkspaceEventBatch<
  ObjectRecordCreateEvent<BlocklistWorkspaceEntity>
>;

@Processor({
  queueName: MessageQueue.messagingQueue,
  scope: Scope.REQUEST,
})
export class BlocklistItemDeleteMessagesJob {
  constructor(
    private readonly threadCleanerService: MessagingMessageCleanerService,
    private readonly workspaceOrmManager: WorkspaceOrmManager,
    @InjectRepository(MessageChannelEntity)
    private readonly messageChannelRepository: Repository<MessageChannelEntity>,
    @InjectRepository(ConnectedAccountEntity)
    private readonly connectedAccountRepository: Repository<ConnectedAccountEntity>,
    @InjectRepository(UserWorkspaceEntity)
    private readonly userWorkspaceRepository: Repository<UserWorkspaceEntity>,
  ) {}

  @Process(BlocklistItemDeleteMessagesJob.name)
  async handle(data: BlocklistItemDeleteMessagesJobData): Promise<void> {
    const workspaceId = data.workspaceId;

    const authContext = buildSystemAuthContext(workspaceId);

    await this.workspaceOrmManager.executeInWorkspaceContext(
      async () => {
        const blocklistItemIds = data.events.map(
          (eventPayload) => eventPayload.recordId,
        );

        const blocklistRepository =
          this.workspaceOrmManager.getRepository<BlocklistWorkspaceEntity>(
            'blocklist',
          );

        const blocklist = await blocklistRepository.find({
          where: {
            id: Any(blocklistItemIds),
          },
        });

        const handlesToDeleteByWorkspaceMemberIdMap = blocklist.reduce(
          (acc, blocklistItem) => {
            const { handle, workspaceMemberId } = blocklistItem;

            if (!isDefined(workspaceMemberId)) {
              return acc;
            }

            if (!acc.has(workspaceMemberId)) {
              acc.set(workspaceMemberId, []);
            }

            if (!isDefined(handle)) {
              return acc;
            }

            acc.get(workspaceMemberId)?.push(handle);

            return acc;
          },
          new Map<string, string[]>(),
        );

        const messageChannelMessageAssociationRepository =
          this.workspaceOrmManager.getRepository<MessageChannelMessageAssociationWorkspaceEntity>(
            'messageChannelMessageAssociation',
          );

        const workspaceMemberRepository =
          this.workspaceOrmManager.getRepository<WorkspaceMemberWorkspaceEntity>(
            'workspaceMember',
            { shouldBypassPermissionChecks: true },
          );

        const messageParticipantRepository =
          this.workspaceOrmManager.getRepository<MessageParticipantWorkspaceEntity>(
            'messageParticipant',
            { shouldBypassPermissionChecks: true },
          );

        const workspaceMemberIds = [
          ...handlesToDeleteByWorkspaceMemberIdMap.keys(),
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
                select: {
                  id: true,
                  handle: true,
                  connectedAccountId: true,
                  connectedAccount: {
                    handleAliases: true,
                  },
                },
                where: {
                  connectedAccountId: In(
                    connectedAccounts.map(({ id }) => id),
                  ),
                  workspaceId,
                },
                relations: { connectedAccount: true },
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

        for (const workspaceMemberId of handlesToDeleteByWorkspaceMemberIdMap.keys()) {
          const handles =
            handlesToDeleteByWorkspaceMemberIdMap.get(workspaceMemberId);

          if (!handles) {
            continue;
          }

          const rolesToDelete = [
            MessageParticipantRole.FROM,
            MessageParticipantRole.TO,
          ] as const;

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

          for (const messageChannel of messageChannelsForMember) {
            const messageChannelHandles = [messageChannel.handle];

            const handleAliases =
              messageChannel.connectedAccount?.handleAliases;

            if (isDefined(handleAliases)) {
              const aliasList: string[] = Array.isArray(handleAliases)
                ? handleAliases
                : (handleAliases as string).split(',');

              messageChannelHandles.push(...aliasList);
            }

            const handleConditions = handles.map((handle) => {
              const isHandleDomain = handle.startsWith('@');

              return isHandleDomain
                ? {
                    handle: And(
                      Or(ILike(`%${handle}`), ILike(`%.${handle.slice(1)}`)),
                      Not(In(messageChannelHandles)),
                    ),
                    role: In(rolesToDelete),
                  }
                : { handle, role: In(rolesToDelete) };
            });

            const matchingParticipants =
              await messageParticipantRepository.find({
                where: handleConditions,
                select: { messageId: true },
              });

            const messageIds = [
              ...new Set(
                matchingParticipants.map(
                  (participant) => participant.messageId,
                ),
              ),
            ];

            if (messageIds.length === 0) {
              continue;
            }

            await messageChannelMessageAssociationRepository.delete({
              messageChannelId: messageChannel.id,
              messageId: In(messageIds),
            });
          }
        }

        await this.threadCleanerService.cleanOrphanMessagesAndThreads(
          workspaceId,
        );
      },
      authContext,
      { lite: true },
    );
  }
}
