import { Scope } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { type ObjectRecordDeleteEvent } from 'twenty-shared/database-events';
import { In, Not, type Repository } from 'typeorm';

import { Process } from 'src/engine/core-modules/message-queue/decorators/process.decorator';
import { Processor } from 'src/engine/core-modules/message-queue/decorators/processor.decorator';
import { MessageQueue } from 'src/engine/core-modules/message-queue/message-queue.constants';
import { UserWorkspaceEntity } from 'src/engine/core-modules/user-workspace/user-workspace.entity';
import { CalendarChannelEntity } from 'src/engine/metadata-modules/calendar-channel/entities/calendar-channel.entity';
import { ConnectedAccountEntity } from 'src/engine/metadata-modules/connected-account/entities/connected-account.entity';
import { WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';
import { buildSystemAuthContext } from 'src/engine/twenty-orm/utils/build-system-auth-context.util';
import { type WorkspaceEventBatch } from 'src/engine/workspace-event-emitter/types/workspace-event-batch.type';
import { type BlocklistWorkspaceEntity } from 'src/modules/blocklist/standard-objects/blocklist.workspace-entity';
import { CalendarChannelSyncStatusService } from 'src/modules/calendar/common/services/calendar-channel-sync-status.service';
import { CalendarChannelSyncStage } from 'twenty-shared/types';
import { isDefined } from 'twenty-shared/utils';
import { type WorkspaceMemberWorkspaceEntity } from 'src/modules/workspace-member/standard-objects/workspace-member.workspace-entity';

export type BlocklistReimportCalendarEventsJobData = WorkspaceEventBatch<
  ObjectRecordDeleteEvent<BlocklistWorkspaceEntity>
>;

@Processor({
  queueName: MessageQueue.calendarQueue,
  scope: Scope.REQUEST,
})
export class BlocklistReimportCalendarEventsJob {
  constructor(
    private readonly workspaceOrmManager: WorkspaceOrmManager,
    @InjectRepository(CalendarChannelEntity)
    private readonly calendarChannelRepository: Repository<CalendarChannelEntity>,
    @InjectRepository(ConnectedAccountEntity)
    private readonly connectedAccountRepository: Repository<ConnectedAccountEntity>,
    @InjectRepository(UserWorkspaceEntity)
    private readonly userWorkspaceRepository: Repository<UserWorkspaceEntity>,
    private readonly calendarChannelSyncStatusService: CalendarChannelSyncStatusService,
  ) {}

  @Process(BlocklistReimportCalendarEventsJob.name)
  async handle(data: BlocklistReimportCalendarEventsJobData): Promise<void> {
    const workspaceId = data.workspaceId;

    const authContext = buildSystemAuthContext(workspaceId);

    await this.workspaceOrmManager.executeInWorkspaceContext(
      async () => {
        const workspaceMemberRepository =
          this.workspaceOrmManager.getRepository<WorkspaceMemberWorkspaceEntity>(
            'workspaceMember',
            { shouldBypassPermissionChecks: true },
          );

        const workspaceMemberIds = data.events.map(
          (eventPayload) => eventPayload.properties.before.workspaceMemberId,
        );

        const workspaceMembers = await workspaceMemberRepository.find({
          where: { id: In(workspaceMemberIds) },
        });

        const workspaceMemberById = new Map(
          workspaceMembers.map((workspaceMember) => [
            workspaceMember.id,
            workspaceMember,
          ]),
        );

        const userIds = workspaceMembers.map(
          (workspaceMember) => workspaceMember.userId,
        );

        const userWorkspaces = await this.userWorkspaceRepository.find({
          where: { userId: In(userIds), workspaceId },
          select: ['id', 'userId'],
        });

        const userWorkspaceByUserId = new Map(
          userWorkspaces.map((userWorkspace) => [
            userWorkspace.userId,
            userWorkspace,
          ]),
        );

        const calendarChannelIdsByUserWorkspaceId =
          await this.getCalendarChannelIdsByUserWorkspaceId(
            userWorkspaces.map((userWorkspace) => userWorkspace.id),
            workspaceId,
          );

        for (const eventPayload of data.events) {
          const workspaceMemberId =
            eventPayload.properties.before.workspaceMemberId;

          const workspaceMember = workspaceMemberById.get(workspaceMemberId);

          if (!isDefined(workspaceMember)) {
            continue;
          }

          const userWorkspace = userWorkspaceByUserId.get(
            workspaceMember.userId,
          );

          if (!isDefined(userWorkspace)) {
            continue;
          }

          const calendarChannelIds =
            calendarChannelIdsByUserWorkspaceId.get(userWorkspace.id) ?? [];

          await this.calendarChannelSyncStatusService.resetAndMarkAsCalendarEventListFetchPending(
            calendarChannelIds,
            workspaceId,
          );
        }
      },
      authContext,
      { lite: true },
    );
  }

  private async getCalendarChannelIdsByUserWorkspaceId(
    userWorkspaceIds: string[],
    workspaceId: string,
  ): Promise<Map<string, string[]>> {
    const connectedAccounts = await this.connectedAccountRepository.find({
      select: ['id', 'userWorkspaceId'],
      where: { userWorkspaceId: In(userWorkspaceIds), workspaceId },
    });

    const userWorkspaceIdByConnectedAccountId = new Map(
      connectedAccounts.map((connectedAccount) => [
        connectedAccount.id,
        connectedAccount.userWorkspaceId,
      ]),
    );

    const calendarChannels = await this.calendarChannelRepository.find({
      select: ['id', 'connectedAccountId'],
      where: {
        connectedAccountId: In(
          connectedAccounts.map((connectedAccount) => connectedAccount.id),
        ),
        syncStage: Not(
          CalendarChannelSyncStage.CALENDAR_EVENT_LIST_FETCH_PENDING,
        ),
        workspaceId,
      },
    });

    const calendarChannelIdsByUserWorkspaceId = new Map<string, string[]>();

    for (const calendarChannel of calendarChannels) {
      const userWorkspaceId = userWorkspaceIdByConnectedAccountId.get(
        calendarChannel.connectedAccountId,
      );

      if (!isDefined(userWorkspaceId)) {
        continue;
      }

      const calendarChannelIds =
        calendarChannelIdsByUserWorkspaceId.get(userWorkspaceId) ?? [];

      calendarChannelIds.push(calendarChannel.id);
      calendarChannelIdsByUserWorkspaceId.set(
        userWorkspaceId,
        calendarChannelIds,
      );
    }

    return calendarChannelIdsByUserWorkspaceId;
  }
}
