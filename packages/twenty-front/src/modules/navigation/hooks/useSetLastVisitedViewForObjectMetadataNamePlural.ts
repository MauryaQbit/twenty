import { lastClickedNavigationMenuItemIdState } from '@/navigation-menu-item/common/states/lastClickedNavigationMenuItemIdState';
import { navigationMenuItemsSelector } from '@/navigation-menu-item/common/states/navigationMenuItemsSelector';
import { lastVisitedViewPerObjectMetadataItemState } from '@/navigation/states/lastVisitedViewPerObjectMetadataItemState';
import { objectMetadataItemsSelector } from '@/object-metadata/states/objectMetadataItemsSelector';
import { viewsSelector } from '@/views/states/selectors/viewsSelector';
import { ViewKey } from '@/views/types/ViewKey';
import { type ViewWithRelations } from '@/views/types/ViewWithRelations';
import { useIsFeatureEnabled } from '@/workspace/hooks/useIsFeatureEnabled';
import { useCallback } from 'react';
import { NavigationMenuItemType } from 'twenty-shared/types';
import { isDefined } from 'twenty-shared/utils';
import { useStore } from 'jotai';
import { FeatureFlagKey } from '~/generated-metadata/graphql';

export const useSetLastVisitedViewForObjectMetadataNamePlural = () => {
  const store = useStore();
  const isInitialObjectViewEnabled = useIsFeatureEnabled(
    FeatureFlagKey.IS_INITIAL_OBJECT_VIEW_ENABLED,
  );
  const setLastVisitedViewForObjectMetadataNamePlural = useCallback(
    async ({
      objectNamePlural,
      viewId,
    }: {
      objectNamePlural: string;
      viewId: string;
    }) => {
      const lastClickedNavigationMenuItem = store
        .get(navigationMenuItemsSelector.atom)
        .find(
          (navigationMenuItem) =>
            navigationMenuItem.id ===
            store.get(lastClickedNavigationMenuItemIdState.atom),
        );

      // A VIEW sidebar entry pins a single view: recording it as the object's
      // last visited view would redirect the object's own sidebar entry to it.
      if (
        lastClickedNavigationMenuItem?.type === NavigationMenuItemType.VIEW &&
        lastClickedNavigationMenuItem.viewId === viewId
      ) {
        return;
      }

      const views = store.get(viewsSelector.atom);

      const view = views.find((view: ViewWithRelations) => view.id === viewId);

      const objectMetadataItems = store.get(objectMetadataItemsSelector.atom);

      const objectMetadataItem = objectMetadataItems.find(
        (item) => item.namePlural === objectNamePlural,
      );

      if (!isDefined(objectMetadataItem) || !isDefined(view)) {
        return;
      }

      if (view.objectMetadataId !== objectMetadataItem.id) {
        return;
      }

      if (isInitialObjectViewEnabled && view.key === ViewKey.INDEX) {
        return;
      }

      const lastVisitedViewPerObjectMetadataItem = store.get(
        lastVisitedViewPerObjectMetadataItemState.atom,
      );

      const lastVisitedViewId =
        lastVisitedViewPerObjectMetadataItem?.[objectMetadataItem?.id];

      if (isDefined(objectMetadataItem) && lastVisitedViewId !== viewId) {
        store.set(lastVisitedViewPerObjectMetadataItemState.atom, {
          ...lastVisitedViewPerObjectMetadataItem,
          [objectMetadataItem.id]: viewId,
        });
      }
    },
    [store, isInitialObjectViewEnabled],
  );

  return {
    setLastVisitedViewForObjectMetadataNamePlural,
  };
};
