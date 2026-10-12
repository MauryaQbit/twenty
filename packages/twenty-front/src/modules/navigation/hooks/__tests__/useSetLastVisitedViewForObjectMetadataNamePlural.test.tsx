import { act, renderHook } from '@testing-library/react';
import { type ReactNode } from 'react';
import { createStore, Provider as JotaiProvider } from 'jotai';

import { metadataStoreState } from '@/metadata-store/states/metadataStoreState';
import { lastClickedNavigationMenuItemIdState } from '@/navigation-menu-item/common/states/lastClickedNavigationMenuItemIdState';
import { useSetLastVisitedViewForObjectMetadataNamePlural } from '@/navigation/hooks/useSetLastVisitedViewForObjectMetadataNamePlural';
import { lastVisitedViewPerObjectMetadataItemState } from '@/navigation/states/lastVisitedViewPerObjectMetadataItemState';
import { getTestEnrichedObjectMetadataItemsMock } from '~/testing/utils/getTestEnrichedObjectMetadataItemsMock';
import { setTestObjectMetadataItemsInMetadataStore } from '~/testing/utils/setTestObjectMetadataItemsInMetadataStore';
import { setTestViewsInMetadataStore } from '~/testing/utils/setTestViewsInMetadataStore';
import { type ViewWithRelations } from '@/views/types/ViewWithRelations';
import { NavigationMenuItemType } from 'twenty-shared/types';
import {
  type NavigationMenuItem,
  ViewKey,
  ViewType,
  ViewVisibility,
} from '~/generated-metadata/graphql';

const PEOPLE_OBJECT_NAME_PLURAL = 'people';

const objectMetadataItems = getTestEnrichedObjectMetadataItemsMock();

const peopleObjectMetadataItem = objectMetadataItems.find(
  (objectMetadataItem) =>
    objectMetadataItem.namePlural === PEOPLE_OBJECT_NAME_PLURAL,
);

if (!peopleObjectMetadataItem) {
  throw new Error('People object metadata item not found in test mock');
}

const buildView = (id: string, key: ViewKey | null): ViewWithRelations => ({
  id,
  name: id,
  key,
  type: ViewType.TABLE,
  objectMetadataId: peopleObjectMetadataItem.id,
  isCompact: false,
  viewFields: [],
  viewGroups: [],
  viewFilters: [],
  viewSorts: [],
  shouldHideEmptyGroups: false,
  position: 0,
  icon: 'IconList',
  visibility: ViewVisibility.WORKSPACE,
  isActive: true,
});

const views = [
  buildView('view-index', ViewKey.INDEX),
  buildView('view-my-contacts', null),
];

const navigationMenuItems: NavigationMenuItem[] = [
  {
    id: 'navigation-menu-item-people',
    type: NavigationMenuItemType.OBJECT,
    targetObjectMetadataId: peopleObjectMetadataItem.id,
    position: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'navigation-menu-item-my-contacts',
    type: NavigationMenuItemType.VIEW,
    targetObjectMetadataId: peopleObjectMetadataItem.id,
    viewId: 'view-my-contacts',
    position: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];

const renderSetLastVisitedViewHook = ({
  lastClickedNavigationMenuItemId,
}: {
  lastClickedNavigationMenuItemId: string | null;
}) => {
  const store = createStore();

  setTestObjectMetadataItemsInMetadataStore(store, objectMetadataItems);
  setTestViewsInMetadataStore(store, views);

  store.set(metadataStoreState.atomFamily('navigationMenuItems'), {
    current: navigationMenuItems,
    draft: [],
    status: 'up-to-date',
  });

  store.set(
    lastClickedNavigationMenuItemIdState.atom,
    lastClickedNavigationMenuItemId,
  );

  const wrapper = ({ children }: { children: ReactNode }) => (
    <JotaiProvider store={store}>{children}</JotaiProvider>
  );

  return {
    store,
    ...renderHook(() => useSetLastVisitedViewForObjectMetadataNamePlural(), {
      wrapper,
    }),
  };
};

describe('useSetLastVisitedViewForObjectMetadataNamePlural', () => {
  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('records the last visited view of the object', async () => {
    const { store, result } = renderSetLastVisitedViewHook({
      lastClickedNavigationMenuItemId: 'navigation-menu-item-people',
    });

    await act(async () => {
      await result.current.setLastVisitedViewForObjectMetadataNamePlural({
        objectNamePlural: PEOPLE_OBJECT_NAME_PLURAL,
        viewId: 'view-my-contacts',
      });
    });

    expect(store.get(lastVisitedViewPerObjectMetadataItemState.atom)).toEqual({
      [peopleObjectMetadataItem.id]: 'view-my-contacts',
    });
  });

  it('records the last visited view when no navigation menu item was clicked', async () => {
    const { store, result } = renderSetLastVisitedViewHook({
      lastClickedNavigationMenuItemId: null,
    });

    await act(async () => {
      await result.current.setLastVisitedViewForObjectMetadataNamePlural({
        objectNamePlural: PEOPLE_OBJECT_NAME_PLURAL,
        viewId: 'view-my-contacts',
      });
    });

    expect(store.get(lastVisitedViewPerObjectMetadataItemState.atom)).toEqual({
      [peopleObjectMetadataItem.id]: 'view-my-contacts',
    });
  });

  it('does not record the view pinned by the clicked view navigation menu item', async () => {
    const { store, result } = renderSetLastVisitedViewHook({
      lastClickedNavigationMenuItemId: 'navigation-menu-item-my-contacts',
    });

    await act(async () => {
      await result.current.setLastVisitedViewForObjectMetadataNamePlural({
        objectNamePlural: PEOPLE_OBJECT_NAME_PLURAL,
        viewId: 'view-my-contacts',
      });
    });

    expect(
      store.get(lastVisitedViewPerObjectMetadataItemState.atom),
    ).toBeNull();
  });

  it('records the last visited view when the clicked view navigation menu item pins another view', async () => {
    const { store, result } = renderSetLastVisitedViewHook({
      lastClickedNavigationMenuItemId: 'navigation-menu-item-my-contacts',
    });

    await act(async () => {
      await result.current.setLastVisitedViewForObjectMetadataNamePlural({
        objectNamePlural: PEOPLE_OBJECT_NAME_PLURAL,
        viewId: 'view-index',
      });
    });

    expect(store.get(lastVisitedViewPerObjectMetadataItemState.atom)).toEqual({
      [peopleObjectMetadataItem.id]: 'view-index',
    });
  });

  it('does not record a view that belongs to another object', async () => {
    const { store, result } = renderSetLastVisitedViewHook({
      lastClickedNavigationMenuItemId: 'navigation-menu-item-people',
    });

    await act(async () => {
      await result.current.setLastVisitedViewForObjectMetadataNamePlural({
        objectNamePlural: PEOPLE_OBJECT_NAME_PLURAL,
        viewId: 'view-of-another-object',
      });
    });

    expect(
      store.get(lastVisitedViewPerObjectMetadataItemState.atom),
    ).toBeNull();
  });
});
