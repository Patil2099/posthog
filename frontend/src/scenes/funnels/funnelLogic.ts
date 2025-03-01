import { isBreakpoint, kea } from 'kea'
import api from 'lib/api'
import { insightLogic } from 'scenes/insights/insightLogic'
import { autocorrectInterval, objectsEqual, uuid } from 'lib/utils'
import { insightHistoryLogic } from 'scenes/insights/InsightHistoryPanel/insightHistoryLogic'
import { funnelsModel } from '~/models/funnelsModel'
import { dashboardItemsModel } from '~/models/dashboardItemsModel'
import { eventUsageLogic } from 'lib/utils/eventUsageLogic'
import { funnelLogicType } from './funnelLogicType'
import {
    EntityTypes,
    FilterType,
    ChartDisplayType,
    FunnelResult,
    FunnelStep,
    FunnelsTimeConversionBins,
    FunnelTimeConversionStep,
    PathType,
    PersonType,
    ViewType,
    FunnelStepWithNestedBreakdown,
    FunnelTimeConversionMetrics,
    FunnelRequestParams,
    LoadedRawFunnelResults,
} from '~/types'
import { featureFlagLogic } from 'lib/logic/featureFlagLogic'
import { FEATURE_FLAGS, FunnelLayout } from 'lib/constants'
import { preflightLogic } from 'scenes/PreflightCheck/logic'
import { FunnelStepReference } from 'scenes/insights/InsightTabs/FunnelTab/FunnelStepReferencePicker'
import { eventDefinitionsModel } from '~/models/eventDefinitionsModel'
import { calcPercentage, cleanBinResult, getLastFilledStep, getReferenceStep } from './funnelUtils'
import { personsModalLogic } from 'scenes/trends/personsModalLogic'
function aggregateBreakdownResult(breakdownList: FunnelStep[][]): FunnelStepWithNestedBreakdown[] {
    if (breakdownList.length) {
        return breakdownList[0].map((step, i) => ({
            ...step,
            count: breakdownList.reduce((total, breakdownSteps) => total + breakdownSteps[i].count, 0),
            nested_breakdown: breakdownList.reduce(
                (allEntries, breakdownSteps) => [...allEntries, breakdownSteps[i]],
                []
            ),
            average_conversion_time: null,
            people: [],
        }))
    }
    return []
}

function isBreakdownFunnelResults(results: FunnelStep[] | FunnelStep[][]): results is FunnelStep[][] {
    return Array.isArray(results) && (results.length === 0 || Array.isArray(results[0]))
}

function wait(ms = 1000): Promise<any> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms)
    })
}

const SECONDS_TO_POLL = 3 * 60

const EMPTY_FUNNEL_RESULTS = {
    results: [],
    timeConversionResults: {
        bins: [],
        average_conversion_time: 0,
    },
}

async function pollFunnel<T = FunnelStep[]>(apiParams: FunnelRequestParams): Promise<FunnelResult<T>> {
    // Tricky: This API endpoint has wildly different return types depending on parameters.
    const { refresh, ...bodyParams } = apiParams
    let result = await api.create('api/insight/funnel/?' + (refresh ? 'refresh=true' : ''), bodyParams)
    const start = window.performance.now()
    while (result.result.loading && (window.performance.now() - start) / 1000 < SECONDS_TO_POLL) {
        await wait()
        result = await api.create('api/insight/funnel', bodyParams)
    }
    // if endpoint is still loading after 3 minutes just return default
    if (result.loading) {
        throw { status: 0, statusText: 'Funnel timeout' }
    }
    return result
}

export const cleanFunnelParams = (filters: Partial<FilterType>): FilterType => {
    return {
        ...filters,
        ...(filters.date_from ? { date_from: filters.date_from } : {}),
        ...(filters.date_to ? { date_to: filters.date_to } : {}),
        ...(filters.actions ? { actions: filters.actions } : {}),
        ...(filters.events ? { events: filters.events } : {}),
        ...(filters.display ? { display: filters.display } : {}),
        ...(filters.interval ? { interval: filters.interval } : {}),
        ...(filters.properties ? { properties: filters.properties } : {}),
        ...(filters.filter_test_accounts ? { filter_test_accounts: filters.filter_test_accounts } : {}),
        ...(filters.funnel_step ? { funnel_step: filters.funnel_step } : {}),
        ...(filters.funnel_viz_type ? { funnel_viz_type: filters.funnel_viz_type } : {}),
        ...(filters.funnel_step ? { funnel_to_step: filters.funnel_step } : {}),
        interval: autocorrectInterval(filters),
        breakdown: filters.breakdown || undefined,
        breakdown_type: filters.breakdown_type || undefined,

        insight: ViewType.FUNNELS,
    }
}
const isStepsEmpty = (filters: FilterType): boolean =>
    [...(filters.actions || []), ...(filters.events || [])].length === 0

export const funnelLogic = kea<funnelLogicType>({
    key: (props) => {
        return props.dashboardItemId || 'some_funnel'
    },

    actions: () => ({
        clearFunnel: true,
        setFilters: (filters: Partial<FilterType>, refresh = false, mergeWithExisting = true) => ({
            filters,
            refresh,
            mergeWithExisting,
        }),
        saveFunnelInsight: (name: string) => ({ name }),
        loadConversionWindow: (days: number) => ({ days }),
        setConversionWindowInDays: (days: number) => ({ days }),
        openPersonsModal: (
            step: FunnelStep | FunnelStepWithNestedBreakdown,
            stepNumber: number,
            breakdown_value?: string
        ) => ({
            step,
            stepNumber,
            breakdown_value,
        }),
        setStepReference: (stepReference: FunnelStepReference) => ({ stepReference }),
        setBarGraphLayout: (barGraphLayout: FunnelLayout) => ({ barGraphLayout }),
        changeHistogramStep: (from_step: number, to_step: number) => ({ from_step, to_step }),
        setIsGroupingOutliers: (isGroupingOutliers) => ({ isGroupingOutliers }),
    }),

    connect: {
        actions: [insightHistoryLogic, ['createInsight'], funnelsModel, ['loadFunnels']],
        values: [preflightLogic, ['preflight']],
    },

    loaders: ({ props, values }) => ({
        rawResults: [
            EMPTY_FUNNEL_RESULTS as LoadedRawFunnelResults,
            {
                loadResults: async (refresh = false, breakpoint): Promise<LoadedRawFunnelResults> => {
                    if (props.cachedResults && !refresh && values.filters === props.filters) {
                        // TODO: cache timeConversionResults? how does this cachedResults work?
                        return {
                            results: props.cachedResults as FunnelStep[] | FunnelStep[][],
                            timeConversionResults: EMPTY_FUNNEL_RESULTS.timeConversionResults,
                        }
                    }

                    const { apiParams, eventCount, actionCount, interval, histogramStep, filters } = values

                    async function loadFunnelResults(): Promise<FunnelResult<FunnelStep[] | FunnelStep[][]>> {
                        try {
                            const result = await pollFunnel<FunnelStep[] | FunnelStep[][]>({
                                ...apiParams,
                                ...(refresh ? { refresh } : {}),
                            })
                            eventUsageLogic.actions.reportFunnelCalculated(eventCount, actionCount, interval, true)
                            return result
                        } catch (e) {
                            breakpoint()
                            eventUsageLogic.actions.reportFunnelCalculated(
                                eventCount,
                                actionCount,
                                interval,
                                false,
                                e.message
                            )
                            throw new Error('Could not load funnel results')
                        }
                    }

                    async function loadBinsResults(): Promise<FunnelsTimeConversionBins> {
                        if (filters.display === ChartDisplayType.FunnelsTimeToConvert) {
                            try {
                                // API specs (#5110) require neither funnel_{from|to}_step to be provided if querying
                                // for all steps
                                const isAllSteps = values.histogramStep.from_step === -1

                                const binsResult = await pollFunnel<FunnelsTimeConversionBins>({
                                    ...apiParams,
                                    ...(refresh ? { refresh } : {}),
                                    funnel_viz_type: 'time_to_convert',
                                    ...(!isAllSteps ? { funnel_from_step: histogramStep.from_step } : {}),
                                    ...(!isAllSteps ? { funnel_to_step: histogramStep.to_step } : {}),
                                })
                                return cleanBinResult(binsResult.result)
                            } catch (e) {
                                throw new Error('Could not load funnel time conversion bins')
                            }
                        }
                        return EMPTY_FUNNEL_RESULTS.timeConversionResults
                    }

                    const queryId = uuid()
                    insightLogic.actions.startQuery(queryId)
                    try {
                        const [result, timeConversionResults] = await Promise.all([
                            loadFunnelResults(),
                            loadBinsResults(),
                        ])
                        breakpoint()
                        insightLogic.actions.endQuery(queryId, ViewType.FUNNELS, result.last_refresh)
                        return { results: result.result, timeConversionResults }
                    } catch (e) {
                        if (!isBreakpoint(e)) {
                            insightLogic.actions.endQuery(queryId, ViewType.FUNNELS, null, e)
                        }
                        console.error(e)
                        return EMPTY_FUNNEL_RESULTS
                    }
                },
            },
        ],
        people: [
            [] as any[],
            {
                loadPeople: async (steps) => {
                    return (await api.get('api/person/?uuid=' + steps[0].people.join(','))).results
                },
            },
        ],
    }),

    reducers: ({ props }) => ({
        filters: [
            (props.filters || {}) as FilterType,
            {
                setFilters: (state, { filters, mergeWithExisting }) =>
                    mergeWithExisting ? { ...state, ...filters } : filters,
                clearFunnel: (state) => ({ new_entity: state.new_entity }),
            },
        ],
        people: {
            clearFunnel: () => [],
        },
        conversionWindowInDays: [
            14,
            {
                setConversionWindowInDays: (state, { days }) => {
                    return days >= 1 && days <= 365 ? Math.round(days) : state
                },
            },
        ],
        stepReference: [
            FunnelStepReference.total as FunnelStepReference,
            {
                setStepReference: (_, { stepReference }) => stepReference,
            },
        ],
        barGraphLayout: [
            FunnelLayout.vertical as FunnelLayout,
            {
                setBarGraphLayout: (_, { barGraphLayout }) => barGraphLayout,
            },
        ],
        histogramStep: [
            { from_step: -1, to_step: -1 } as FunnelTimeConversionStep,
            {
                changeHistogramStep: (_, { from_step, to_step }) => ({ from_step, to_step }),
            },
        ],
        isGroupingOutliers: [
            true,
            {
                setIsGroupingOutliers: (_, { isGroupingOutliers }) => isGroupingOutliers,
            },
        ],
    }),

    selectors: ({ props, selectors }) => ({
        isLoading: [(s) => [s.rawResultsLoading], (rawResultsLoading) => rawResultsLoading],
        results: [(s) => [s.rawResults], (rawResults) => rawResults.results],
        timeConversionBins: [(s) => [s.rawResults], (rawResults) => rawResults.timeConversionResults],
        peopleSorted: [
            () => [selectors.stepsWithCount, selectors.people],
            (steps, people) => {
                if (!people) {
                    return null
                }
                const score = (person: PersonType): number => {
                    return steps.reduce(
                        (val, step) => (person.uuid && step.people?.indexOf(person.uuid) > -1 ? val + 1 : val),
                        0
                    )
                }
                return people.sort((a, b) => score(b) - score(a))
            },
        ],
        isStepsEmpty: [() => [selectors.filters], (filters: FilterType) => isStepsEmpty(filters)],
        propertiesForUrl: [() => [selectors.filters], (filters: FilterType) => cleanFunnelParams(filters)],
        isValidFunnel: [
            () => [selectors.stepsWithCount, selectors.timeConversionBins],
            (stepsWithCount: FunnelStep[], timeConversionBins: FunnelsTimeConversionBins) => {
                return (
                    (stepsWithCount && stepsWithCount[0] && stepsWithCount[0].count > -1) ||
                    timeConversionBins?.bins?.length > 0
                )
            },
        ],
        showBarGraph: [
            () => [selectors.filters],
            ({ display }: { display: ChartDisplayType }) =>
                display === ChartDisplayType.FunnelViz || display === ChartDisplayType.FunnelsTimeToConvert,
        ],
        clickhouseFeaturesEnabled: [
            () => [featureFlagLogic.selectors.featureFlags, selectors.preflight],
            // Controls auto-calculation of results and ability to break down values
            (featureFlags, preflight): boolean =>
                !!(featureFlags[FEATURE_FLAGS.FUNNEL_BAR_VIZ] && preflight?.is_clickhouse_enabled),
        ],
        funnelPersonsEnabled: [
            () => [featureFlagLogic.selectors.featureFlags, selectors.preflight],
            (featureFlags, preflight): boolean =>
                !!(featureFlags[FEATURE_FLAGS.FUNNEL_BAR_VIZ] && preflight?.is_clickhouse_enabled),
        ],
        histogramGraphData: [
            () => [selectors.timeConversionBins],
            (timeConversionBins: FunnelsTimeConversionBins) => {
                if (timeConversionBins?.bins.length < 2) {
                    return []
                }
                const binSize = timeConversionBins.bins[1][0] - timeConversionBins.bins[0][0]
                return timeConversionBins.bins.map(([id, count]: [id: number, count: number]) => {
                    const value = Math.max(0, id)
                    return {
                        id: value,
                        bin0: value,
                        bin1: value + binSize,
                        count,
                    }
                })
            },
        ],
        histogramStepsDropdown: [
            () => [selectors.stepsWithCount, selectors.conversionMetrics],
            (stepsWithCount, conversionMetrics) => {
                const stepsDropdown: FunnelTimeConversionStep[] = []

                if (stepsWithCount.length > 1) {
                    stepsDropdown.push({
                        label: `All steps`,
                        from_step: -1,
                        to_step: -1,
                        count: stepsWithCount[stepsWithCount.length - 1].count,
                        average_conversion_time: conversionMetrics.averageTime,
                    })
                }

                stepsWithCount.forEach((_, idx) => {
                    if (stepsWithCount[idx + 1]) {
                        stepsDropdown.push({
                            label: `Steps ${idx + 1} and ${idx + 2}`,
                            from_step: idx,
                            to_step: idx + 1,
                            count: stepsWithCount[idx + 1].count,
                            average_conversion_time: stepsWithCount[idx + 1].average_conversion_time ?? 0,
                        })
                    }
                })
                return stepsDropdown
            },
        ],
        areFiltersValid: [
            () => [selectors.filters],
            (filters) => {
                return (filters.events?.length || 0) + (filters.actions?.length || 0) > 1
            },
        ],
        conversionMetrics: [
            () => [selectors.stepsWithCount, selectors.histogramStep],
            (stepsWithCount, timeStep): FunnelTimeConversionMetrics => {
                if (stepsWithCount.length <= 1) {
                    return {
                        averageTime: 0,
                        stepRate: 0,
                        totalRate: 0,
                    }
                }

                const isAllSteps = timeStep.from_step === -1
                const fromStep = isAllSteps
                    ? getReferenceStep(stepsWithCount, FunnelStepReference.total)
                    : stepsWithCount[timeStep.from_step]
                const toStep = isAllSteps ? getLastFilledStep(stepsWithCount) : stepsWithCount[timeStep.to_step]

                return {
                    averageTime: toStep?.average_conversion_time || 0,
                    stepRate: calcPercentage(toStep.count, fromStep.count),
                    totalRate: calcPercentage(stepsWithCount[stepsWithCount.length - 1].count, stepsWithCount[0].count),
                }
            },
        ],
        apiParams: [
            (s) => [s.filters, s.conversionWindowInDays, featureFlagLogic.selectors.featureFlags],
            (filters, conversionWindowInDays, featureFlags) => {
                const { from_dashboard } = filters
                const cleanedParams = cleanFunnelParams(filters)
                return {
                    ...(props.refresh ? { refresh: true } : {}),
                    ...(from_dashboard ? { from_dashboard } : {}),
                    ...cleanedParams,
                    funnel_window_days: conversionWindowInDays,
                    ...(!featureFlags[FEATURE_FLAGS.FUNNEL_BAR_VIZ] ? { breakdown: null, breakdown_type: null } : {}),
                }
            },
        ],
        eventCount: [() => [selectors.apiParams], (apiParams) => apiParams.events?.length || 0],
        actionCount: [() => [selectors.apiParams], (apiParams) => apiParams.actions?.length || 0],
        interval: [() => [selectors.apiParams], (apiParams) => apiParams.interval || ''],
        stepsWithNestedBreakdown: [
            () => [selectors.results],
            (results) => {
                if (isBreakdownFunnelResults(results)) {
                    return aggregateBreakdownResult(results).sort((a, b) => a.order - b.order)
                }
                return []
            },
        ],
        steps: [
            () => [selectors.results, selectors.stepsWithNestedBreakdown, selectors.filters],
            (results, stepsWithNestedBreakdown, filters): FunnelStepWithNestedBreakdown[] =>
                !!filters.breakdown
                    ? stepsWithNestedBreakdown
                    : ([...results] as FunnelStep[]).sort((a, b) => a.order - b.order),
        ],
        stepsWithCount: [() => [selectors.steps], (steps) => steps.filter((step) => typeof step.count === 'number')],
    }),

    listeners: ({ actions, values, props }) => ({
        loadResultsSuccess: async () => {
            // load the old people table
            if (!featureFlagLogic.values.featureFlags[FEATURE_FLAGS.FUNNEL_BAR_VIZ]) {
                if (values.stepsWithCount[0]?.people?.length > 0) {
                    actions.loadPeople(values.stepsWithCount)
                }
            }
        },
        setFilters: ({ refresh }) => {
            // FUNNEL_BAR_VIZ removes the calculate button on Clickhouse
            // Query performance is suboptimal on psql
            const { clickhouseFeaturesEnabled } = values
            if (refresh || clickhouseFeaturesEnabled) {
                actions.loadResults()
            }
            const cleanedParams = cleanFunnelParams(values.filters)
            insightLogic.actions.setAllFilters(cleanedParams)
            insightLogic.actions.setLastRefresh(null)
        },
        saveFunnelInsight: async ({ name }) => {
            await api.create('api/insight', {
                filters: values.filters,
                name,
                saved: true,
            })
            actions.loadFunnels()
        },
        clearFunnel: async () => {
            insightLogic.actions.setAllFilters({})
        },
        [dashboardItemsModel.actionTypes.refreshAllDashboardItems]: (filters) => {
            if (props.dashboardItemId) {
                actions.setFilters(filters, true)
            }
        },
        loadConversionWindow: async ({ days }, breakpoint) => {
            await breakpoint(1000)
            actions.setConversionWindowInDays(days)
            actions.loadResults()
        },
        openPersonsModal: ({ step, stepNumber, breakdown_value }) => {
            personsModalLogic.actions.setShowingPeople(true)
            personsModalLogic.actions.loadPeople({
                action: { id: step.action_id, name: step.name, properties: [], type: step.type },
                breakdown_value: breakdown_value || '',
                label: `Persons who ${stepNumber >= 0 ? 'completed' : 'dropped off at'} Step #${Math.abs(
                    stepNumber
                )} - ${step.name}`,
                date_from: '',
                date_to: '',
                filters: values.filters,
                saveOriginal: true,
                funnelStep: stepNumber,
            })
        },
        changeHistogramStep: () => {
            actions.loadResults()
        },
    }),
    actionToUrl: ({ values, props }) => ({
        setFilters: () => {
            if (!props.dashboardItemId) {
                return ['/insights', values.propertiesForUrl, undefined, { replace: true }]
            }
        },
        clearFunnel: () => {
            if (!props.dashboardItemId) {
                return ['/insights', { insight: ViewType.FUNNELS }, undefined, { replace: true }]
            }
        },
    }),
    urlToAction: ({ actions, values, props }) => ({
        '/insights': (_, searchParams: Partial<FilterType>) => {
            if (props.dashboardItemId) {
                return
            }
            if (searchParams.insight === ViewType.FUNNELS) {
                const paramsToCheck = {
                    date_from: searchParams.date_from,
                    date_to: searchParams.date_to,
                    actions: searchParams.actions,
                    events: searchParams.events,
                    display: searchParams.display,
                    interval: searchParams.interval,
                    properties: searchParams.properties,
                }
                const _filters = {
                    date_from: values.filters.date_from,
                    date_to: values.filters.date_to,
                    actions: values.filters.actions,
                    events: values.filters.events,
                    interval: values.filters.interval,

                    properties: values.filters.properties,
                }
                if (!objectsEqual(_filters, paramsToCheck)) {
                    const cleanedParams = cleanFunnelParams(searchParams)
                    if (isStepsEmpty(cleanedParams)) {
                        const event = eventDefinitionsModel.values.eventNames.includes(PathType.PageView)
                            ? PathType.PageView
                            : eventDefinitionsModel.values.eventNames[0]
                        cleanedParams.events = [
                            {
                                id: event,
                                name: event,
                                type: EntityTypes.EVENTS,
                                order: 0,
                            },
                        ]
                    }
                    actions.setFilters(cleanedParams, true, false)
                }
            }
        },
    }),
})
