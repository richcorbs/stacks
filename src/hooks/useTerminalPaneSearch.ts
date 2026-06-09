import { useCallback, useEffect, useRef, useState } from 'react';
import { focusPaneSession, getPaneSession } from '../terminalSessionManager';
import { countSearchMatches } from '../terminalSearch';

export function useTerminalPaneSearch(paneId: string, searchRequestNonce: number) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [searchResultText, setSearchResultText] = useState('');
  const [searchMatchCount, setSearchMatchCount] = useState(0);
  const [searchMatchIndex, setSearchMatchIndex] = useState(0);
  const searchOpenRef = useRef(searchOpen);
  const searchTermRef = useRef(searchTerm);
  const lastSearchRequestNonceRef = useRef(searchRequestNonce);
  searchOpenRef.current = searchOpen;
  searchTermRef.current = searchTerm;

  const onSearchResultsChange = useCallback(({ resultIndex, resultCount }: { resultIndex: number; resultCount: number }) => {
    if (!searchOpenRef.current || !searchTermRef.current) return;
    setSearchMatchCount(resultCount);
    setSearchMatchIndex(resultCount > 0 && resultIndex >= 0 ? resultIndex + 1 : 0);
    setSearchResultText(resultCount > 0 && resultIndex >= 0 ? `${resultIndex + 1}/${resultCount}` : '0/0');
  }, []);

  useEffect(() => {
    if (searchRequestNonce <= 0 || searchRequestNonce === lastSearchRequestNonceRef.current) return;
    lastSearchRequestNonceRef.current = searchRequestNonce;
    setSearchOpen(true);
  }, [searchRequestNonce]);

  useEffect(() => {
    const session = getPaneSession(paneId);
    if (!session) return;
    if (!searchOpen || !searchTerm) {
      if (!searchOpen) session.search.clearDecorations();
      setSearchResultText('');
      setSearchMatchCount(0);
      setSearchMatchIndex(0);
      return;
    }
    const count = countSearchMatches(session.term, searchTerm);
    setSearchMatchCount(count);
    setSearchMatchIndex(count > 0 ? 1 : 0);
    setSearchResultText(count > 0 ? `1/${count}` : '0/0');
    try {
      const found = session.search.findNext(searchTerm, { incremental: true });
      if (!found) setSearchResultText('0/0');
    } catch (err) {
      console.error('terminal search failed', err);
      setSearchResultText('');
    }
  }, [paneId, searchOpen, searchTerm]);

  function onNext() {
    const session = getPaneSession(paneId);
    if (session && searchTerm) {
      try {
        const found = session.search.findNext(searchTerm);
        if (found && searchMatchCount > 0) {
          const nextIndex = (searchMatchIndex % searchMatchCount) + 1;
          setSearchMatchIndex(nextIndex);
          setSearchResultText(`${nextIndex}/${searchMatchCount}`);
        }
      } catch (err) { console.error('terminal search failed', err); }
    }
  }

  function onPrevious() {
    const session = getPaneSession(paneId);
    if (session && searchTerm) {
      try {
        const found = session.search.findPrevious(searchTerm);
        if (found && searchMatchCount > 0) {
          const nextIndex = ((searchMatchIndex - 2 + searchMatchCount) % searchMatchCount) + 1;
          setSearchMatchIndex(nextIndex);
          setSearchResultText(`${nextIndex}/${searchMatchCount}`);
        }
      } catch (err) { console.error('terminal search failed', err); }
    }
  }

  function onClose() {
    getPaneSession(paneId)?.search.clearDecorations();
    setSearchOpen(false);
    setSearchTerm('');
    focusPaneSession(paneId, 'close-search', { scrollToBottom: false });
  }

  return {
    searchOpen,
    searchTerm,
    searchResultText,
    setSearchTerm,
    onNext,
    onPrevious,
    onClose,
    onSearchResultsChange,
  };
}
