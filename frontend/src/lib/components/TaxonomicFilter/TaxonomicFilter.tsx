import './TaxonomicFilter.scss'
import React, { useEffect, useMemo, useRef } from 'react'
import { Input } from 'antd'
import { useValues, useActions, BindLogic } from 'kea'
import { InfiniteSelectResults } from './InfiniteSelectResults'
import { taxonomicFilterLogic } from './taxonomicFilterLogic'
import {
    TaxonomicFilterGroupType,
    TaxonomicFilterLogicProps,
    TaxonomicFilterProps,
} from 'lib/components/TaxonomicFilter/types'

let uniqueMemoizedIndex = 0

export function TaxonomicFilter({
    taxonomicFilterLogicKey: taxonomicFilterLogicKeyInput,
    groupType,
    value,
    onChange,
    onClose,
    groupTypes = [
        TaxonomicFilterGroupType.EventProperties,
        TaxonomicFilterGroupType.PersonProperties,
        TaxonomicFilterGroupType.Cohorts,
    ],
}: TaxonomicFilterProps): JSX.Element {
    // Generate a unique key for each unique TaxonomicFilter that's rendered
    const taxonomicFilterLogicKey = useMemo(
        () => taxonomicFilterLogicKeyInput || `taxonomic-filter-${uniqueMemoizedIndex++}`,
        [taxonomicFilterLogicKeyInput]
    )

    const searchInputRef = useRef<Input | null>(null)
    const focusInput = (): void => searchInputRef.current?.focus()

    const taxonomicFilterLogicProps: TaxonomicFilterLogicProps = {
        taxonomicFilterLogicKey,
        groupType,
        value,
        onChange,
        groupTypes,
    }
    const logic = taxonomicFilterLogic(taxonomicFilterLogicProps)
    const { searchQuery } = useValues(logic)
    const { setSearchQuery, moveUp, moveDown, tabLeft, tabRight, selectSelected } = useActions(logic)

    useEffect(() => {
        window.setTimeout(() => focusInput(), 1)
    }, [])

    return (
        <BindLogic logic={taxonomicFilterLogic} props={taxonomicFilterLogicProps}>
            <div className="taxonomic-filter">
                <Input
                    placeholder="Search cohorts, event or person properties"
                    value={searchQuery}
                    ref={(ref) => (searchInputRef.current = ref)}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'ArrowUp') {
                            e.preventDefault()
                            moveUp()
                        }
                        if (e.key === 'ArrowDown') {
                            e.preventDefault()
                            moveDown()
                        }
                        if (e.key === 'Tab') {
                            e.preventDefault()
                            if (e.shiftKey) {
                                tabLeft()
                            } else {
                                tabRight()
                            }
                        }
                        if (e.key === 'Enter') {
                            e.preventDefault()
                            selectSelected()
                        }
                        if (e.key === 'Escape') {
                            e.preventDefault()
                            onClose?.()
                        }
                    }}
                />
                <InfiniteSelectResults focusInput={focusInput} taxonomicFilterLogicProps={taxonomicFilterLogicProps} />
            </div>
        </BindLogic>
    )
}
