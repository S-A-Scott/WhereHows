import Component from '@ember/component';
import { get, set, setProperties } from '@ember/object';
import ComputedProperty from '@ember/object/computed';
import { inject } from '@ember/service';
import { task } from 'ember-concurrency';
import { action } from 'ember-decorators/object';
import Notifications, { NotificationEvent } from 'wherehows-web/services/notifications';
import { IDatasetColumn } from 'wherehows-web/typings/api/datasets/columns';
import { IComplianceInfo, IComplianceSuggestion } from 'wherehows-web/typings/api/datasets/compliance';
import { IDatasetView } from 'wherehows-web/typings/api/datasets/dataset';
import { IDatasetSchema } from 'wherehows-web/typings/api/datasets/schema';
import { IComplianceDataType } from 'wherehows-web/typings/api/list/compliance-datatypes';
import {
  IReadComplianceResult,
  notFoundApiError,
  readDatasetComplianceByUrn,
  readDatasetComplianceSuggestionByUrn,
  saveDatasetComplianceByUrn,
  saveDatasetComplianceSuggestionFeedbackByUrn
} from 'wherehows-web/utils/api';
import { columnDataTypesAndFieldNames } from 'wherehows-web/utils/api/datasets/columns';
import { readDatasetSchemaByUrn } from 'wherehows-web/utils/api/datasets/schema';
import { readComplianceDataTypes } from 'wherehows-web/utils/api/list/compliance-datatypes';
import {
  compliancePolicyStrings,
  removeReadonlyAttr,
  filterEditableEntities,
  SuggestionIntent
} from 'wherehows-web/constants';
import { iterateArrayAsync } from 'wherehows-web/utils/array';

/**
 * Type alias for the response when container data items are batched
 */
type BatchComplianceResponse = [
  IReadComplianceResult,
  Array<IComplianceDataType>,
  IComplianceSuggestion,
  IDatasetSchema
];

/**
 * Type alias for the result of invoking the batch operation, properties are set on container
 */
type BatchContainerDataResult = Pick<
  DatasetComplianceContainer,
  | 'isNewComplianceInfo'
  | 'complianceInfo'
  | 'complianceDataTypes'
  | 'complianceSuggestion'
  | 'schemaFieldNamesMappedToDataTypes'
  | 'schemaless'
>;

const { successUpdating, failedUpdating } = compliancePolicyStrings;

export default class DatasetComplianceContainer extends Component {
  /**
   * External action on parent
   */
  setOnChangeSetChange: (hasSuggestions: boolean) => void;

  /**
   * External action on parent
   */
  setOnComplianceType: (args: { isNewComplianceInfo: boolean; fromUpstream: boolean }) => void;

  /**
   * External action on parent
   */
  setOnChangeSetDrift: (hasDrift: boolean) => void;

  /**
   * Mapping of field names on the dataset schema to the respective dataType
   * @type {Array<Pick<IDatasetColumn, 'dataType' | 'fieldName'>>}
   */
  schemaFieldNamesMappedToDataTypes: Array<Pick<IDatasetColumn, 'dataType' | 'fieldName'>> = [];

  /**
   * List of compliance data-type objects
   * @type {Array<IComplianceDataType>}
   */
  complianceDataTypes: Array<IComplianceDataType> = [];

  /**
   * Flag indicating that the compliance information for this dataset is new
   * @type {boolean}
   */
  isNewComplianceInfo: boolean = false;

  /**
   * Object containing the suggested values for the compliance form
   * @type {IComplianceSuggestion | void}
   */
  complianceSuggestion: IComplianceSuggestion | void;

  /**
   * Reference to the application notifications Service
   * @type {ComputedProperty<Notifications>}
   */
  notifications: ComputedProperty<Notifications> = inject();

  /**
   * Object containing the compliance information for the dataset
   * @type {IComplianceInfo | void}
   */
  complianceInfo: IComplianceInfo | void;

  /**
   * The platform / db that the dataset is persisted
   * @type {IDatasetView.platform}
   */
  platform: IDatasetView['platform'];

  /**
   * Flag indicating if the dataset has a schema representation
   * @type {boolean}
   */
  schemaless: boolean = false;

  /**
   * The nativeName of the dataset
   * @type {string}
   */
  datasetName: string = '';

  /**
   * The urn identifier for the dataset
   * @type {string}
   */
  urn: string;

  didInsertElement() {
    get(this, 'getContainerDataTask').perform();
  }

  didUpdateAttrs() {
    get(this, 'getContainerDataTask').perform();
  }

  /**
   * An async parent task to group all data tasks for this container component
   * @type {Task<TaskInstance<Promise<any>>, (a?: any) => TaskInstance<TaskInstance<Promise<any>>>>}
   */
  getContainerDataTask = task(function*(
    this: DatasetComplianceContainer
  ): IterableIterator<Promise<BatchContainerDataResult>> {
    const { notify } = get(this, 'notifications');

    try {
      yield this.batchContainerData();
    } catch (e) {
      notify(NotificationEvent.info, { content: e });
    }
  }).drop();

  /**
   * Sets dataset properties in batch after waiting for all data requests to resolve
   * @return {Promise<Pick<DatasetComplianceContainer, "isNewComplianceInfo" | "complianceInfo" | "complianceDataTypes" | "complianceSuggestion" | "schemaFieldNamesMappedToDataTypes" | "schemaless">>}
   */
  async batchContainerData(this: DatasetComplianceContainer): Promise<BatchContainerDataResult> {
    const urn: string = get(this, 'urn');
    const [
      { isNewComplianceInfo, complianceInfo },
      complianceDataTypes,
      complianceSuggestion,
      { columns, schemaless }
    ]: BatchComplianceResponse = await Promise.all([
      readDatasetComplianceByUrn(urn),
      readComplianceDataTypes(),
      readDatasetComplianceSuggestionByUrn(urn),
      readDatasetSchemaByUrn(urn)
    ]);
    const schemaFieldNamesMappedToDataTypes = await iterateArrayAsync(columnDataTypesAndFieldNames)(columns);

    this.onCompliancePolicyStateChange.call(this, { isNewComplianceInfo, fromUpstream: !!complianceInfo.fromUpstream });

    return setProperties(this, {
      isNewComplianceInfo,
      complianceInfo,
      complianceDataTypes,
      complianceSuggestion,
      schemaFieldNamesMappedToDataTypes,
      schemaless
    });
  }

  /**
   * Reads the compliance properties for the dataset
   * @type {Task<Promise<IReadComplianceResult>, (a?: any) => TaskInstance<Promise<IReadComplianceResult>>>}
   */
  getComplianceTask = task(function*(
    this: DatasetComplianceContainer
  ): IterableIterator<Promise<IReadComplianceResult>> {
    const { isNewComplianceInfo, complianceInfo }: IReadComplianceResult = yield readDatasetComplianceByUrn(
      get(this, 'urn')
    );

    this.onCompliancePolicyStateChange({ isNewComplianceInfo, fromUpstream: !!complianceInfo.fromUpstream });
    setProperties(this, { isNewComplianceInfo, complianceInfo });
  });

  /**
   * Reads the compliance data types
   * @type {Task<Promise<Array<IComplianceDataType>>, (a?: any) => TaskInstance<Promise<Array<IComplianceDataType>>>>}
   */
  getComplianceDataTypesTask = task(function*(
    this: DatasetComplianceContainer
  ): IterableIterator<Promise<Array<IComplianceDataType>>> {
    const complianceDataTypes: Array<IComplianceDataType> = yield readComplianceDataTypes();

    set(this, 'complianceDataTypes', complianceDataTypes);
  });

  /**
   * Reads the suggestions for the compliance properties on the dataset
   * @type {Task<Promise<IComplianceSuggestion>, (a?: any) => TaskInstance<Promise<IComplianceSuggestion>>>}
   */
  getComplianceSuggestionsTask = task(function*(
    this: DatasetComplianceContainer
  ): IterableIterator<Promise<IComplianceSuggestion>> {
    const complianceSuggestion: IComplianceSuggestion = yield readDatasetComplianceSuggestionByUrn(get(this, 'urn'));

    set(this, 'complianceSuggestion', complianceSuggestion);
  });

  /**
   * Reads the schema properties for the dataset
   * @type {Task<Promise<IDatasetSchema>, (a?: any) => TaskInstance<Promise<IDatasetSchema>>>}
   */
  getDatasetSchemaTask = task(function*(
    this: DatasetComplianceContainer
  ): IterableIterator<Promise<IDatasetSchema | Pick<IDatasetColumn, 'dataType' | 'fieldName'>[]>> {
    try {
      const { columns, schemaless }: IDatasetSchema = yield readDatasetSchemaByUrn(get(this, 'urn'));
      const schemaFieldNamesMappedToDataTypes = yield iterateArrayAsync(columnDataTypesAndFieldNames)(columns);
      setProperties(this, { schemaFieldNamesMappedToDataTypes, schemaless });
    } catch (e) {
      // If this schema is missing, silence exception, otherwise propagate
      if (!notFoundApiError(e)) {
        throw e;
      }
    }
  });

  /**
   * Handles user notifications when save succeeds or fails
   * @template T the return type for the save request
   * @param {Promise<T>} request async policy save request
   * @returns {Promise<T>}
   * @memberof DatasetComplianceContainer
   */
  async notifyOnSave<T>(this: DatasetComplianceContainer, request: Promise<T>): Promise<T> {
    const { notify } = get(this, 'notifications');

    try {
      await request;
      notify(NotificationEvent.success, { content: successUpdating });
    } catch (e) {
      notify(NotificationEvent.error, { content: failedUpdating });
    }

    return request;
  }

  /**
   * Persists the updates to the compliance policy on the remote host
   * @return {Promise<void>}
   */
  @action
  async savePrivacyCompliancePolicy(this: DatasetComplianceContainer): Promise<void> {
    const complianceInfo = get(this, 'complianceInfo');
    if (complianceInfo) {
      const { complianceEntities } = complianceInfo;

      await this.notifyOnSave<void>(
        saveDatasetComplianceByUrn(get(this, 'urn'), {
          ...complianceInfo,
          // filter out readonly entities, then fleece readonly attribute from remaining entities before save
          complianceEntities: removeReadonlyAttr(filterEditableEntities(complianceEntities))
        })
      );

      this.resetPrivacyCompliancePolicy.call(this);
    }
  }

  /**
   * Resets the compliance information for the dataset with the previously persisted properties
   */
  @action
  resetPrivacyCompliancePolicy() {
    get(this, 'getComplianceTask').perform();
  }

  /**
   * Invokes external action if field suggestions change
   * @param {boolean} hasSuggestions
   */
  @action
  onSuggestionsChanged(hasSuggestions: boolean) {
    this.setOnChangeSetChange(hasSuggestions);
  }

  /**
   * Invokes external action if compliance info is new or otherwise
   * @param {boolean} isNewComplianceInfo flag indicating the policy does not exist remotely
   * @param {boolean} fromUpstream flag indicating related dataset compliance info is derived
   */
  @action
  onCompliancePolicyStateChange({
    isNewComplianceInfo,
    fromUpstream
  }: {
    isNewComplianceInfo: boolean;
    fromUpstream: boolean;
  }) {
    this.setOnComplianceType({ isNewComplianceInfo, fromUpstream });
  }

  /**
   * Invokes external action on compliance policy fields drift
   * @param {boolean} hasDrift
   */
  @action
  onCompliancePolicyChangeSetDrift(hasDrift: boolean) {
    this.setOnChangeSetDrift(hasDrift);
  }

  /**
   * Invokes the external action to save feedback on a compliance suggestion
   * @param {string | null} uid the uuid for the compliance suggestion
   * @param {SuggestionIntent} feedback
   */
  @action
  onSuggestionsComplianceFeedback(uid: string | null = null, feedback: SuggestionIntent) {
    saveDatasetComplianceSuggestionFeedbackByUrn(get(this, 'urn'), uid, feedback);
  }
}
