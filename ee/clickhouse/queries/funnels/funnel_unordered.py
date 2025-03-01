from typing import List, Union

from ee.clickhouse.queries.funnels.base import ClickhouseFunnelBase


class ClickhouseFunnelUnordered(ClickhouseFunnelBase):
    """
    Unordered Funnel is a funnel where the order of steps doesn't matter.

    ## Query Intuition

    Imagine a funnel with three events: A, B, and C.
    This query splits the problem into two parts:
    1. Given the first event is A, find the furthest everyone went starting from A.
       This finds any B's and C's that happen after A (without ordering them)
    2. Repeat the above, assuming first event to be B, and then C.
    
    Then, the outer query unions the result of (2) and takes the maximum of these.

    ## Results

    The result format is the same as the basic funnel, i.e. [step, count].
    Here, `step_i` (0 indexed) signifies the number of people that did at least `i+1` steps.
    """

    def get_query(self):

        max_steps = len(self._filter.entities)

        breakdown_clause = self._get_breakdown_prop()

        return f"""
        SELECT {self._get_count_columns(max_steps)} {self._get_step_time_avgs(max_steps)} {breakdown_clause} FROM (
            {self.get_step_counts_query()}
        ) {'GROUP BY prop' if breakdown_clause != '' else ''} SETTINGS allow_experimental_window_functions = 1
        """

    def get_step_counts_query(self):

        max_steps = len(self._filter.entities)

        union_query = self.get_step_counts_without_aggregation_query()
        breakdown_clause = self._get_breakdown_prop()

        return f"""
            SELECT person_id, steps {self._get_step_time_avgs(max_steps)} {breakdown_clause} FROM (
                SELECT person_id, steps, max(steps) over (PARTITION BY person_id {breakdown_clause}) as max_steps {self._get_step_time_names(max_steps)} {breakdown_clause} FROM (
                        {union_query}
                )
            ) GROUP BY person_id, steps {breakdown_clause}
            HAVING steps = max_steps
        """

    def get_step_counts_without_aggregation_query(self):
        max_steps = len(self._filter.entities)
        union_queries = []
        entities_to_use = list(self._filter.entities)

        partition_select = self._get_partition_cols(1, max_steps)
        sorting_condition = self.get_sorting_condition(max_steps)
        breakdown_clause = self._get_breakdown_prop()

        for i in range(max_steps):
            inner_query = f"""
                SELECT 
                person_id,
                timestamp,
                {partition_select}
                {breakdown_clause}
                FROM ({self._get_inner_event_query(entities_to_use, f"events_{i}")})
            """

            formatted_query = f"""
                SELECT *, {sorting_condition} AS steps {self._get_step_times(max_steps)} FROM (
                        {inner_query}
                    ) WHERE step_0 = 1"""

            #  rotate entities by 1 to get new first event
            entities_to_use.append(entities_to_use.pop(0))
            union_queries.append(formatted_query)

        return " UNION ALL ".join(union_queries)

    def _get_step_time_names(self, max_steps: int):
        names = []
        for i in range(1, max_steps):
            names.append(f"step_{i}_average_conversion_time")

        formatted = ",".join(names)
        return f", {formatted}" if formatted else ""

    def _get_step_times(self, max_steps: int):
        conditions: List[str] = []

        conversion_times_elements = []
        for i in range(max_steps):
            conversion_times_elements.append(f"latest_{i}")

        conditions.append(f"arraySort([{','.join(conversion_times_elements)}]) as conversion_times")

        for i in range(1, max_steps):
            conditions.append(
                f"if(isNotNull(conversion_times[{i+1}]), dateDiff('second', conversion_times[{i}], conversion_times[{i+1}]), NULL) step_{i}_average_conversion_time"
            )
            # array indices in ClickHouse are 1-based :shrug:

        formatted = ", ".join(conditions)
        return f", {formatted}" if formatted else ""

    def get_sorting_condition(self, max_steps: int):

        basic_conditions: List[str] = []
        for i in range(1, max_steps):
            basic_conditions.append(
                f"if(latest_0 < latest_{i} AND latest_{i} <= latest_0 + INTERVAL {self._filter.funnel_window_days} DAY, 1, 0)"
            )

        if basic_conditions:
            return f"arraySum([{','.join(basic_conditions)}, 1])"
        else:
            return "1"
