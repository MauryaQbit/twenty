import { Injectable } from '@nestjs/common';

import { CampaignDeliveryEntity } from 'src/engine/core-modules/emailing-domain/campaign-delivery.entity';
import { type CampaignProviderOutcome } from 'src/engine/core-modules/emailing-domain/types/campaign-provider-outcome.type';
import { buildCampaignDeliveryOutcomeUpdate } from 'src/engine/core-modules/emailing-domain/utils/build-campaign-delivery-outcome-update.util';
import { InjectWorkspaceScopedRepository } from 'src/engine/twenty-orm/workspace-scoped-repository/inject-workspace-scoped-repository.decorator';
import { WorkspaceScopedRepository } from 'src/engine/twenty-orm/workspace-scoped-repository/workspace-scoped-repository';
import { MessageCampaignStatisticsService } from 'src/modules/emailing/services/message-campaign-statistics.service';
import { isDefined } from 'twenty-shared/utils';

@Injectable()
export class MessageCampaignDeliveryFeedbackService {
  constructor(
    @InjectWorkspaceScopedRepository(CampaignDeliveryEntity)
    private readonly campaignDeliveryRepository: WorkspaceScopedRepository<CampaignDeliveryEntity>,
    private readonly messageCampaignStatisticsService: MessageCampaignStatisticsService,
  ) {}

  async recordProviderOutcomeByProviderMessageId({
    workspaceId,
    providerMessageId,
    outcome,
  }: {
    workspaceId: string;
    providerMessageId: string;
    outcome: CampaignProviderOutcome;
  }): Promise<void> {
    const update = buildCampaignDeliveryOutcomeUpdate({
      outcome,
      occurredAt: new Date(),
    });

    if (Object.keys(update).length === 0) {
      return;
    }

    const delivery = await this.campaignDeliveryRepository.findOneBy(
      workspaceId,
      { providerMessageId },
    );

    if (!isDefined(delivery)) {
      return;
    }

    await this.campaignDeliveryRepository.update(
      workspaceId,
      { id: delivery.id },
      update,
    );

    await this.messageCampaignStatisticsService.scheduleRefresh({
      workspaceId,
      campaignId: delivery.campaignId,
    });
  }
}
